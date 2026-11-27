import { ROAD_PRESETS, emptyProject } from '../model/defaults';
import { newId } from '../model/store';
import type { Band, CtrlPoint, Entity, OverlayEntity, Params, Pose, Project, PropEntity, RoadEntity, RoadProfile, VehicleEntity, VehicleMarks, VehicleType } from '../model/types';
import { CATALOG } from '../scene/props';
import { genericSpec, TYPICAL } from '../vehicles/spec';
import type { SketchResult, SketchRoad, XY } from './schema';

/**
 * Convierte la lectura del croquis (píxeles de la imagen) en un escenario a escala:
 * vías con su sección, vehículos con sus posiciones ① ② ③ (e intermedias), el punto de
 * colisión, señales y marcas, objetos y los textos del croquis como notas. El croquis queda
 * como calco alineado debajo para comparar.
 */

const DEG = Math.PI / 180;
const norm = (a: number) => ((a % 360) + 360) % 360;
const HALF = 145; // medio lado útil del terreno

/** Anchura real de la calzada (de borde a borde pavimentado) y carril, por tipo de vía. */
const ROAD_KIND: Record<string, { preset: string; lane: number; shoulder: number; limit: number }> = {
  autovia: { preset: 'convencional', lane: 3.5, shoulder: 1.5, limit: 120 },
  convencional: { preset: 'convencional', lane: 3.5, shoulder: 1.0, limit: 90 },
  secundaria: { preset: 'secundaria', lane: 3.0, shoulder: 0, limit: 70 },
  urbana: { preset: 'calle_estrecha', lane: 3.25, shoulder: 0, limit: 50 },
  camino: { preset: 'camino', lane: 2.0, shoulder: 0, limit: 30 },
};
const kindOf = (r: SketchRoad) => ROAD_KIND[r.kind ?? ''] ?? ROAD_KIND.convencional;
const realWidth = (r: SketchRoad) => {
  const k = kindOf(r);
  const lanes = Math.max(1, r.lanes ?? 2);
  return lanes * k.lane + 2 * k.shoulder;
};

const VTYPE: Record<string, VehicleType> = {
  turismo: 'compacto',
  coche: 'compacto',
  suv: 'suv',
  furgoneta: 'furgoneta',
  furgon: 'furgon',
  camion: 'camion',
  tractora: 'tractora',
  autobus: 'autobus',
  moto: 'moto',
  motocicleta: 'moto',
  ciclomotor: 'ciclomotor',
  bicicleta: 'bicicleta',
  patinete: 'patinete',
  peaton: 'peaton',
};
const COLORS = ['#c62828', '#1565c0', '#f2f2f2', '#2e7d32', '#212121', '#9e9e9e', '#f9a825', '#6d4c41'];

export interface SketchBuildInfo {
  /** Metros por píxel usados y de dónde salen. */
  scale: number;
  scaleFrom: string;
  roads: number;
  vehicles: { label: string; positions: string[] }[];
  signs: number;
  warnings: string[];
}

const median = (a: number[]) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

/** Elige la escala (m/px): cotas escritas › anchura de la vía principal › longitud de los coches. */
export function sketchScale(r: SketchResult, w: number, h: number): { s: number; from: string } {
  const diag = Math.hypot(w, h);
  const ok = (s: number) => isFinite(s) && s > 0 && diag * s > 15 && diag * s < 600;
  if (r.meters_per_px && ok(r.meters_per_px)) return { s: r.meters_per_px, from: r.scale_evidence ? `cotas del croquis (${r.scale_evidence})` : 'cotas del croquis' };
  const roads = r.roads.filter((x) => x.width_px > 4);
  const main = roads.find((x) => x.main) ?? [...roads].sort((a, b) => b.width_px - a.width_px)[0];
  if (main) {
    const s = realWidth(main) / main.width_px;
    if (ok(s)) return { s, from: `ancho de ${main.name || 'la vía principal'} (${realWidth(main).toFixed(1)} m: ${main.lanes ?? 2} carriles${kindOf(main).shoulder ? ' y arcenes' : ''})` };
  }
  const cars = r.vehicles.flatMap((v) => {
    const t = VTYPE[v.type] ?? 'compacto';
    return v.positions.filter((p) => (p.length_px ?? 0) > 3).map((p) => TYPICAL[t].L / p.length_px!);
  });
  const sv = median(cars);
  if (ok(sv)) return { s: sv, from: 'tamaño de los vehículos dibujados' };
  return { s: 60 / Math.max(w, h), from: 'supuesta (60 m de ancho de dibujo)' };
}

/** Distancia de un punto a una polilínea y el punto más cercano (con su tangente). */
function nearestOn(pts: { x: number; z: number }[], x: number, z: number) {
  let best = { d: Infinity, x: 0, z: 0, tx: 1, tz: 0, i: 0, t: 0 };
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / L2));
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best.d) {
      const L = Math.sqrt(L2);
      best = { d, x: px, z: pz, tx: dx / L, tz: dz / L, i, t };
    }
  }
  return best;
}

/** Remuestrea una polilínea cada `step` m; si es casi recta, la deja recta. */
function resample(pts: { x: number; z: number }[], step: number): { x: number; z: number }[] {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const L = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const dev = Math.max(...pts.map((p) => Math.abs((p.x - a.x) * (b.z - a.z) - (p.z - a.z) * (b.x - a.x)) / L));
  const src = dev < Math.max(1.5, L * 0.02) ? [a, b] : pts;
  const out: { x: number; z: number }[] = [src[0]];
  let carry = 0;
  for (let i = 0; i < src.length - 1; i++) {
    const p = src[i];
    const q = src[i + 1];
    const seg = Math.hypot(q.x - p.x, q.z - p.z);
    let s = step - carry;
    while (s < seg) {
      out.push({ x: p.x + ((q.x - p.x) * s) / seg, z: p.z + ((q.z - p.z) * s) / seg });
      s += step;
    }
    carry = seg - (s - step);
  }
  const last = src[src.length - 1];
  if (Math.hypot(out[out.length - 1].x - last.x, out[out.length - 1].z - last.z) < step * 0.4) out.pop();
  out.push(last);
  return out;
}

/** Recorta un tramo desde `p` en la dirección (tx,tz) hasta el borde útil del terreno. */
function toEdge(px: number, pz: number, tx: number, tz: number, max: number) {
  let t = max;
  if (tx > 1e-6) t = Math.min(t, (HALF - px) / tx);
  if (tx < -1e-6) t = Math.min(t, (-HALF - px) / tx);
  if (tz > 1e-6) t = Math.min(t, (HALF - pz) / tz);
  if (tz < -1e-6) t = Math.min(t, (-HALF - pz) / tz);
  return Math.max(0, t);
}

function profileFor(r: SketchRoad): RoadProfile {
  const k = kindOf(r);
  const p = (ROAD_PRESETS[k.preset] ?? ROAD_PRESETS.convencional).make();
  const perSide = Math.max(1, Math.round((r.lanes ?? 2) / 2));
  if (perSide > 1) {
    const extend = (side: Band[]) => {
      const lane = side.find((b) => b.type === 'carril');
      if (!lane) return side;
      const rest = side.filter((b) => b.type !== 'carril');
      const lanes: Band[] = Array.from({ length: perSide }, (_, i) => ({ ...lane, line: i === perSide - 1 ? lane.line : 'discontinua' }));
      return [...lanes, ...rest];
    };
    p.left = extend(p.left);
    p.right = extend(p.right);
    p.center = 'continua';
  }
  return p;
}

const SIGN_CODE: Record<string, string> = { stop: 'stop', ceda: 'ceda', velocidad: 'velocidad', prohibido: 'entrada' };
const OBJ_TYPE: Record<string, string> = { arbol: 'arbol', farola: 'farola', poste: 'poste', edificio: 'edificio', contenedor: 'contenedor', bolardo: 'bolardo' };

/**
 * Construye el proyecto. `imageUrl` es el croquis (ya con el papel transparente) para el calco;
 * `w`×`h` es el tamaño de la imagen que leyó la IA.
 */
export function projectFromSketch(r: SketchResult, w: number, h: number, imageUrl: string | null, name?: string): { project: Project; assets: Map<string, string>; info: SketchBuildInfo } {
  const warnings: string[] = [];
  const { s, from } = sketchScale(r, w, h);
  const phi = -(r.north_deg ?? 0);
  const c = Math.cos(phi * DEG);
  const sn = Math.sin(phi * DEG);
  // origen: el punto de colisión (o las posiciones de choque, o el centro del dibujo)
  const cols = r.vehicles.flatMap((v) => v.positions.filter((p) => p.role === 'col').map((p) => p.center));
  const o: XY = r.impact ?? (cols.length ? [cols.reduce((a, p) => a + p[0], 0) / cols.length, cols.reduce((a, p) => a + p[1], 0) / cols.length] : [w / 2, h / 2]);
  const W = (p: XY) => {
    const du = (p[0] - o[0]) * s;
    const dv = (p[1] - o[1]) * s;
    return { x: du * c - dv * sn, z: du * sn + dv * c };
  };
  const H = (deg: number) => norm(deg + phi);

  const p = emptyProject();
  const texts = r.texts ?? [];
  const roadName = texts.find((t) => t.meaning === 'road_name')?.text;
  const pk = texts.find((t) => t.meaning === 'pk')?.text;
  p.name = name || [roadName, pk].filter(Boolean).join(' · ') || 'Croquis interpretado';
  const E: Entity[] = [];

  // ---- Vías ----
  const order = [...r.roads].sort((a, b) => Number(!!b.main) - Number(!!a.main) || b.width_px - a.width_px);
  const placed: { e: RoadEntity; pts: { x: number; z: number }[]; half: number; lane: number }[] = [];
  for (const [i, rd] of order.entries()) {
    let pts = rd.centerline.map(W);
    const half = realWidth(rd) / 2;
    // extremos: si caen sobre otra vía ya colocada, terminan en su eje (cruce); si no, se prolongan
    const fixEnd = (atStart: boolean) => {
      const e = atStart ? pts[0] : pts[pts.length - 1];
      const prev = atStart ? pts[1] : pts[pts.length - 2];
      for (const q of placed) {
        const n = nearestOn(q.pts, e.x, e.z);
        if (n.d < q.half + half + 3) {
          const snap = { x: n.x, z: n.z };
          if (atStart) pts[0] = snap;
          else pts[pts.length - 1] = snap;
          return;
        }
      }
      const L = Math.hypot(e.x - prev.x, e.z - prev.z) || 1;
      const tx = (e.x - prev.x) / L;
      const tz = (e.z - prev.z) / L;
      const t = toEdge(e.x, e.z, tx, tz, 90);
      const far = { x: e.x + tx * t, z: e.z + tz * t };
      if (atStart) pts.unshift(far);
      else pts.push(far);
    };
    fixEnd(true);
    fixEnd(false);
    pts = resample(pts, 20);
    const k = kindOf(rd);
    const nameFromText = rd.name || (i === 0 ? roadName : undefined);
    const e: RoadEntity = {
      id: newId('r'),
      kind: 'road',
      name: nameFromText || (i === 0 ? 'Vía principal' : order.length === 2 ? 'Vía secundaria' : `Vía ${i + 1}`),
      points: pts.map((q): CtrlPoint => ({ x: q.x, z: q.z, h: null })),
      profile: profileFor(rd),
      priority: i === 0 ? 2 : 0,
      limit: k.limit,
    };
    E.push(e);
    placed.push({ e, pts, half, lane: k.lane });
  }
  if (!placed.length) warnings.push('No se ha reconocido ninguna vía: dibújala con la herramienta Carretera sobre el calco.');

  // ---- Vehículos ----
  const vehicles: SketchBuildInfo['vehicles'] = [];
  for (const [i, v] of r.vehicles.entries()) {
    const tipo = VTYPE[v.type.toLowerCase()] ?? 'compacto';
    const marks: VehicleMarks = {};
    const tags: string[] = [];
    const pose = (q: (typeof v.positions)[number]): Pose => ({ ...W(q.center), h: H(q.heading_deg) });
    for (const q of v.positions) {
      tags.push(q.tag || q.role);
      if (q.role === 'mid') (marks.mid ??= []).push(pose(q));
      else if (q.role === 'col') marks.col ??= pose(q);
      else marks[q.role] = pose(q); // la última «final» (PF) manda
    }
    const spec = genericSpec(tipo);
    const at = marks.fin ?? marks.col ?? marks.ini ?? marks.mid![0];
    const label = v.label.replace(/\s+/g, '').slice(0, 3).toUpperCase() || String.fromCharCode(65 + i);
    const ve: VehicleEntity = {
      id: newId('v'),
      kind: 'vehicle',
      name: `${label} · ${TYPICAL[tipo].label}${v.description ? ` (${v.description})` : ''}`.slice(0, 80),
      label,
      spec,
      x: at.x,
      z: at.z,
      heading: at.h,
      color: tipo === 'peaton' ? '#3d6e9e' : COLORS[i % COLORS.length],
      plate: '',
      occupants: tipo === 'peaton' ? 0 : 1,
      cargo: 0,
      damage: [],
      photos: [],
      marks,
    };
    E.push(ve);
    vehicles.push({ label, positions: tags });
    if (!marks.col) warnings.push(`${label}: el croquis no muestra su posición en el choque (②); colócala tú o se deducirá.`);
  }

  // ---- Señales y marcas ----
  const prop = (type: string, nm: string, x: number, z: number, rot: number, params: Params = {}): PropEntity => {
    const pe: PropEntity = { id: newId('p'), kind: 'prop', type, name: nm, x, z, rot: norm(rot), dy: 0, params: { ...(CATALOG[type]?.defaults ?? {}), ...params } };
    E.push(pe);
    return pe;
  };
  /** Sentido del tráfico en un punto: el de la vía más cercana, hacia el cruce o el punto de colisión. */
  const trafficAt = (x: number, z: number, given: number | null | undefined) => {
    if (given != null) return H(given);
    const q = placed.map((pl) => ({ pl, n: nearestOn(pl.pts, x, z) })).sort((a, b) => a.n.d - b.n.d)[0];
    if (!q) return 0;
    const toO = -(x * q.n.tx + z * q.n.tz); // el origen (choque) está en x=z=0
    const [tx, tz] = toO >= 0 ? [q.n.tx, q.n.tz] : [-q.n.tx, -q.n.tz];
    return norm(Math.atan2(tx, -tz) / DEG);
  };
  /** Coloca algo fuera de la calzada, a la derecha del tráfico al que se dirige. */
  const roadside = (x: number, z: number, hdg: number) => {
    const q = placed.map((pl) => ({ pl, n: nearestOn(pl.pts, x, z) })).sort((a, b) => a.n.d - b.n.d)[0];
    if (!q || q.n.d > q.pl.half + 6) return { x, z, road: q };
    const rx = Math.cos(hdg * DEG);
    const rz = Math.sin(hdg * DEG);
    const off = q.pl.half + 1.2;
    return { x: q.n.x + rx * off, z: q.n.z + rz * off, road: q };
  };
  let signs = 0;
  const stopLines: { x: number; z: number }[] = [];
  for (const m of r.markings ?? []) {
    const at = W(m.position);
    const hd = trafficAt(at.x, at.z, m.heading_deg);
    if (m.type === 'linea_detencion') {
      stopLines.push(at);
      prop('linea_detencion', 'Línea de detención', at.x, at.z, hd, { ancho: 3.5 });
    } else if (m.type === 'paso_peatones') prop('paso_peatones', 'Paso de peatones', at.x, at.z, hd + 90);
    else if (m.type === 'flecha') prop('flecha', 'Flecha', at.x, at.z, hd);
  }
  for (const sg of r.signs ?? []) {
    const at = W(sg.position);
    const hd = trafficAt(at.x, at.z, sg.traffic_heading_deg);
    const side = roadside(at.x, at.z, hd);
    signs++;
    if (sg.type === 'semaforo') {
      prop('semaforo', 'Semáforo', side.x, side.z, hd);
      continue;
    }
    if (sg.type === 'paso_peatones') {
      prop('paso_peatones', 'Paso de peatones', at.x, at.z, hd + 90);
      continue;
    }
    const code = SIGN_CODE[sg.type];
    if (!code) {
      signs--;
      warnings.push(`Señal «${sg.value ?? sg.type}» no reconocida: añádela desde Objetos.`);
      continue;
    }
    if (code === 'stop') {
      const v = r.vehicles.find((x) => x.positions.some((q) => q.role === 'ini' && Math.abs(norm(H(q.heading_deg) - hd + 180) - 180) < 40));
      if (v) warnings.push(`${v.label} tenía STOP: si arrancó desde parado, pon su velocidad inicial baja (en el inspector, posiciones) y la app recalcula.`);
    }
    const label = code === 'stop' ? 'STOP' : code === 'ceda' ? 'Ceda el paso' : code === 'velocidad' ? `Velocidad ${sg.value ?? ''}` : 'Dirección prohibida';
    prop('senal', label, side.x, side.z, hd, { senal: code, ...(code === 'velocidad' && sg.value ? { valor: String(sg.value).replace(/\D/g, '') || '50' } : {}) });
    // STOP / ceda: línea de detención en su carril si el croquis no la dibuja
    if ((code === 'stop' || code === 'ceda') && side.road && !stopLines.some((q) => Math.hypot(q.x - side.x, q.z - side.z) < 8)) {
      let n = side.road.n;
      // la línea va donde la vía se une a la otra (borde de la calzada que cruza)
      const others = placed.filter((q) => q !== side.road!.pl);
      const [fx, fz] = [Math.sin(hd * DEG), -Math.cos(hd * DEG)];
      for (let d = 0; d < 40 && others.length; d += 0.5) {
        const px = n.x + fx * d;
        const pz = n.z + fz * d;
        const hit = others.find((q) => nearestOn(q.pts, px, pz).d < q.half + 1);
        if (hit) {
          const m = nearestOn(side.road.pl.pts, px, pz);
          n = { ...m };
          break;
        }
      }
      const rx = Math.cos(hd * DEG);
      const rz = Math.sin(hd * DEG);
      const lane = side.road.pl.lane;
      prop('linea_detencion', code === 'stop' ? 'Línea de detención (STOP)' : 'Línea de ceda el paso', n.x + rx * lane * 0.5, n.z + rz * lane * 0.5, hd, { ancho: lane, tipo: code === 'stop' ? 'continua' : 'discontinua', texto_stop: code === 'stop' });
    }
  }
  for (const ob of r.objects ?? []) {
    const t = OBJ_TYPE[ob.type];
    if (!t) continue;
    const at = W(ob.position);
    prop(t, ob.label || CATALOG[t]?.label || t, at.x, at.z, 0);
  }
  if (pk && placed[0]) {
    const n = nearestOn(placed[0].pts, 0, 0);
    const rx = -n.tz;
    const rz = n.tx;
    prop('hito_km', `P.K. ${pk.replace(/^p\.?\s*k\.?\s*/i, '')}`, n.x + rx * (placed[0].half + 1.5) + n.tx * 15, n.z + rz * (placed[0].half + 1.5) + n.tz * 15, Math.atan2(n.tx, -n.tz) / DEG, { pk: pk.replace(/^p\.?\s*k\.?\s*/i, '') });
  }

  // ---- Calco alineado ----
  const assets = new Map<string, string>();
  if (imageUrl) {
    const asset = newId('img');
    assets.set(asset, imageUrl);
    const ctr = W([w / 2, h / 2]);
    const ov: OverlayEntity = { id: newId('o'), kind: 'overlay', name: 'Croquis (calco)', asset, cx: ctr.x, cz: ctr.z, width: w * s, aspect: h / w, rot: norm(phi), opacity: 0.5, onRoads: true };
    E.unshift(ov);
  }

  // ---- Notas del croquis ----
  const lines: string[] = [];
  if (r.summary) lines.push(r.summary);
  for (const t of texts) if (['cause', 'legend', 'note', 'direction', 'road_name', 'pk', 'scale'].includes(t.meaning ?? '')) lines.push(`«${t.text}»`);
  p.notes = lines.join('\n');
  p.entities = E;
  p.impact = { x: 0, z: 0 };
  return { project: p, assets, info: { scale: s, scaleFrom: from, roads: placed.length, vehicles, signs, warnings: [...warnings, ...(r.uncertainties ?? [])] } };
}
