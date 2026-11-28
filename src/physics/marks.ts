import type { CtrlPoint, MarkRole, Pose, Project, RoadEntity, VehicleEntity } from '../model/types';
import type { World } from '../scene/world';
import { Path } from './path';

/**
 * Posiciones del croquis → recorrido simulado.
 *
 * El usuario sitúa cada vehículo como en el croquis del atestado: ① dónde estaba al empezar,
 * ② dónde estaba en el instante del choque, ③ dónde quedó y, si quiere, puntos intermedios.
 * Aquí se deduce la conducción: una ruta que pasa por esas posiciones siguiendo la carretera,
 * llegada a ② exactamente en t = 0 y ③ como posición final con la que se compara la física.
 */

export const ROLES: Record<MarkRole, { n: string; name: string; long: string; help: string }> = {
  ini: { n: '1', name: 'Inicial', long: 'Posición inicial', help: 'Dónde estaba al empezar la secuencia (por ejemplo, cuando apareció el peligro).' },
  col: { n: '2', name: 'Colisión', long: 'Posición en el choque', help: 'Dónde estaba exactamente en el instante del choque.' },
  fin: { n: '3', name: 'Final', long: 'Posición final', help: 'Dónde quedó detenido después del accidente.' },
  mid: { n: '·', name: 'Intermedia', long: 'Posición intermedia', help: 'Un punto por el que pasó entre la inicial y la del choque.' },
};

const fwd = (h: number): [number, number] => [Math.sin((h * Math.PI) / 180), -Math.cos((h * Math.PI) / 180)];

/** Distancia del centro al eje trasero (la ruta la sigue el eje trasero). */
function rearOffset(e: VehicleEntity) {
  const sp = e.spec;
  return sp.batalla ? sp.volD + sp.batalla - sp.L / 2 : 0;
}
export function rearPoint(e: VehicleEntity, p: Pose): CtrlPoint {
  const [fx, fz] = fwd(p.h);
  const d = rearOffset(e);
  return { x: p.x - fx * d, z: p.z - fz * d, h: null };
}
export function frontPoint(e: VehicleEntity, p: Pose) {
  const [fx, fz] = fwd(p.h);
  return { x: p.x + (fx * e.spec.L) / 2, z: p.z + (fz * e.spec.L) / 2 };
}

/** Lista de posiciones de un vehículo con su papel (para dibujarlas y seleccionarlas). */
export function markList(e: VehicleEntity): { key: string; role: MarkRole; pose: Pose; label: string }[] {
  const m = e.marks;
  if (!m) return [];
  const out: { key: string; role: MarkRole; pose: Pose; label: string }[] = [];
  if (m.ini) out.push({ key: 'ini', role: 'ini', pose: m.ini, label: `${e.label}1` });
  (m.mid ?? []).forEach((p, i) => out.push({ key: `mid:${i}`, role: 'mid', pose: p, label: `${e.label}·${i + 1}` }));
  if (m.col) out.push({ key: 'col', role: 'col', pose: m.col, label: `${e.label}2` });
  if (m.fin) out.push({ key: 'fin', role: 'fin', pose: m.fin, label: `${e.label}3` });
  return out;
}

export function getMark(e: VehicleEntity, key: string): Pose | null {
  const m = e.marks;
  if (!m) return null;
  if (key.startsWith('mid:')) return m.mid?.[Number(key.slice(4))] ?? null;
  return (m[key as 'ini' | 'col' | 'fin'] as Pose | undefined) ?? null;
}
export function setMark(e: VehicleEntity, key: string, p: Pose | null) {
  const m = (e.marks ??= {});
  const pose = p ? { x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100, h: Math.round((((p.h % 360) + 360) % 360) * 10) / 10 } : null;
  if (key === 'mid') {
    if (pose) (m.mid ??= []).push(pose);
  } else if (key.startsWith('mid:')) {
    const i = Number(key.slice(4));
    if (pose && m.mid) m.mid[i] = pose;
    else if (m.mid) m.mid.splice(i, 1);
  } else if (pose) m[key as 'ini' | 'col' | 'fin'] = pose;
  else delete m[key as 'ini' | 'col' | 'fin'];
}

// ---------------------------------------------------------------------------

interface RoadHit {
  road: RoadEntity;
  s: number;
  lat: number;
}

/** Proyección sobre la carretera más cercana (y alineada con el rumbo, si se da). */
function onRoad(world: World, roads: RoadEntity[], x: number, z: number, h?: number): RoadHit | null {
  let best: { road: RoadEntity; i: number; score: number } | null = null;
  const [fx, fz] = h === undefined ? [0, 0] : fwd(h);
  for (const r of roads) {
    const S = world.samples.get(r.id);
    if (!S) continue;
    for (let i = 0; i < S.length; i++) {
      const d = Math.hypot(S[i].x - x, S[i].z - z);
      if (d > 14) continue;
      const align = h === undefined ? 1 : Math.abs(S[i].tx * fx + S[i].tz * fz);
      const score = d + 10 * (1 - align);
      if (!best || score < best.score) best = { road: r, i, score };
    }
  }
  if (!best) return null;
  const S = world.samples.get(best.road.id)!;
  const q = S[best.i];
  return { road: best.road, s: q.s, lat: (x - q.x) * -q.tz + (z - q.z) * q.tx };
}

function roadPoint(world: World, road: RoadEntity, s: number, lat: number): CtrlPoint {
  const S = world.samples.get(road.id)!;
  let lo = 0;
  let hi = S.length - 1;
  s = Math.max(S[0].s, Math.min(S[hi].s, s));
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (S[m].s <= s) lo = m;
    else hi = m;
  }
  const a = S[lo];
  const b = S[hi];
  const u = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
  const x = a.x + (b.x - a.x) * u;
  const z = a.z + (b.z - a.z) * u;
  const tx = a.tx + (b.tx - a.tx) * u;
  const tz = a.tz + (b.tz - a.tz) * u;
  const l = Math.hypot(tx, tz) || 1;
  return { x: x + (-tz / l) * lat, z: z + (tx / l) * lat, h: null };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Puntos interiores de un tramo entre dos posiciones: por la carretera si ambas están sobre la misma vía. */
function between(world: World, roads: RoadEntity[], a: CtrlPoint, ha: number, b: CtrlPoint, hb: number): CtrlPoint[] {
  const ra = onRoad(world, roads, a.x, a.z, ha);
  const rb = onRoad(world, roads, b.x, b.z, hb);
  const dist = Math.hypot(b.x - a.x, b.z - a.z);
  if (ra && rb && ra.road.id === rb.road.id && Math.abs(rb.s - ra.s) > 4) {
    const n = Math.max(1, Math.ceil(Math.abs(rb.s - ra.s) / 6));
    const out: CtrlPoint[] = [];
    for (let k = 1; k < n; k++) {
      const u = k / n;
      out.push(roadPoint(world, ra.road, ra.s + (rb.s - ra.s) * u, ra.lat + (rb.lat - ra.lat) * smooth(u)));
    }
    return out;
  }
  // fuera de la vía: tramo recto que sale y llega con el rumbo de cada posición
  if (dist < 10) return [];
  const [fax, faz] = fwd(ha);
  const [fbx, fbz] = fwd(hb);
  const k = Math.min(6, dist / 4);
  return [
    { x: a.x + fax * k, z: a.z + faz * k, h: null },
    { x: b.x - fbx * k, z: b.z - fbz * k, h: null },
  ];
}

/** Prolongación por la carretera (o recta) desde una posición, hacia delante (+) o hacia atrás (−). */
function extend(world: World, roads: RoadEntity[], p: CtrlPoint, h: number, len: number): CtrlPoint[] {
  const r = onRoad(world, roads, p.x, p.z, h);
  const dir = Math.sign(len);
  if (r) {
    const S = world.samples.get(r.road.id)!;
    const i = S.reduce((bi, q, k) => (Math.abs(q.s - r.s) < Math.abs(S[bi].s - r.s) ? k : bi), 0);
    const [fx, fz] = fwd(h);
    const along = S[i].tx * fx + S[i].tz * fz >= 0 ? 1 : -1; // sentido de marcha respecto al trazado
    const out: CtrlPoint[] = [];
    for (let d = 6; d <= Math.abs(len); d += 6) out.push(roadPoint(world, r.road, r.s + along * dir * d, r.lat));
    return out;
  }
  const [fx, fz] = fwd(h);
  return [Math.abs(len) / 2, Math.abs(len)].map((d) => ({ x: p.x + fx * d * dir, z: p.z + fz * d * dir, h: null }));
}

/** Límite de velocidad de la vía bajo un punto (para la velocidad por defecto). */
function defaultSpeed(world: World, roads: RoadEntity[], e: VehicleEntity, p: Pose) {
  if (e.spec.tipo === 'peaton') return 5;
  if (e.spec.tipo === 'bicicleta' || e.spec.tipo === 'patinete') return 18;
  const r = onRoad(world, roads, p.x, p.z, p.h);
  return r?.road.limit ? Math.round(r.road.limit * 0.9) : 50;
}

/**
 * Deduce la conducción de un vehículo a partir de sus posiciones del croquis.
 * Sin ① ni ② el vehículo queda parado (en ③ si la hay).
 */
export function applyMarks(world: World, e: VehicleEntity) {
  const m = e.marks;
  if (!m) return;
  const roads = world.store.project.entities.filter((x): x is RoadEntity => x.kind === 'road');
  if (m.fin) {
    e.x = m.fin.x;
    e.z = m.fin.z;
    e.heading = m.fin.h;
  }
  if (!m.ini && !m.col) {
    if (!m.fin && m.mid?.length) {
      e.x = m.mid[0].x;
      e.z = m.mid[0].z;
      e.heading = m.mid[0].h;
    }
    delete e.drive;
    return;
  }
  // posiciones en orden: ① · intermedias (ordenadas a lo largo del recorrido) · ②
  const first = m.ini ?? m.col!;
  const last = m.col ?? m.ini!;
  const [dx, dz] = [last.x - first.x, last.z - first.z];
  const mids = [...(m.mid ?? [])].sort((a, b) => (a.x - first.x) * dx + (a.z - first.z) * dz - ((b.x - first.x) * dx + (b.z - first.z) * dz));
  const keys: Pose[] = [];
  if (m.ini) keys.push(m.ini);
  keys.push(...mids);
  if (m.col) keys.push(m.col);
  const pts: CtrlPoint[] = [];
  const r0 = rearPoint(e, keys[0]);
  // sin posición inicial: viene de atrás por su carril
  if (!m.ini) pts.push(...extend(world, roads, r0, keys[0].h, -150).reverse());
  pts.push(r0);
  for (let i = 1; i < keys.length; i++) {
    const a = rearPoint(e, keys[i - 1]);
    const b = rearPoint(e, keys[i]);
    const mid = between(world, roads, a, keys[i - 1].h, b, keys[i].h);
    // llegar a la posición con el rumbo dibujado: un punto de aproximación en su dirección
    const [fx, fz] = fwd(keys[i].h);
    const appr = { x: b.x - fx * 5, z: b.z - fz * 5, h: null };
    const kept = mid.filter((q) => Math.hypot(q.x - b.x, q.z - b.z) > 8);
    pts.push(...kept, appr, b);
  }
  // después: sigue en la dirección que llevaba (la física decide el resto)
  const lastKey = keys[keys.length - 1];
  pts.push(...extend(world, roads, rearPoint(e, lastKey), lastKey.h, m.col ? 30 : 200));
  const path = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.4);
  const d = (e.drive ??= { path: [], speed: defaultSpeed(world, roads, e, first), sync: false, abs: true, events: [], showFinal: false, speedAuto: true });
  d.path = path;
  d.showFinal = !!m.fin;
  if (m.col) {
    d.sync = true;
    d.syncPoint = frontPoint(e, m.col);
    d.colPose = { ...m.col };
    delete d.startS;
  } else {
    d.sync = false;
    delete d.syncPoint;
    delete d.colPose;
    // la posición inicial está al empezar la secuencia
    d.startS = new Path(path).project(r0.x, r0.z);
  }
}

/**
 * Pone al día todo lo que depende de las posiciones: la conducción de cada vehículo, el punto de
 * colisión común (para el marcador y el análisis) y el inicio de la secuencia, de modo que el
 * vehículo que antes estaba en su posición inicial aparezca ahí al empezar.
 */
export function applyAllMarks(world: World, p: Project) {
  const vehicles = p.entities.filter((x): x is VehicleEntity => x.kind === 'vehicle' && !!x.marks);
  if (!vehicles.length) return;
  for (const v of vehicles) applyMarks(world, v);
  const cols = vehicles.filter((v) => v.marks?.col).map((v) => frontPoint(v, v.marks!.col!));
  if (cols.length && !p.impactLocked) p.impact = { x: cols.reduce((s, c) => s + c.x, 0) / cols.length, z: cols.reduce((s, c) => s + c.z, 0) / cols.length };
  // Inicio de la secuencia. Las posiciones ① se consideran simultáneas (como en el croquis: dónde
  // estaba cada uno cuando surgió el peligro). Los vehículos con velocidad «calculada» la ajustan
  // para estar en su ① al empezar; el de recorrido más largo va a la velocidad habitual de la vía.
  const roads = p.entities.filter((x): x is RoadEntity => x.kind === 'road');
  const legs: { v: VehicleEntity; d: number; brake: number; auto: boolean; vRef: number }[] = [];
  for (const v of vehicles) {
    const m = v.marks!;
    if (!m.ini || !m.col || !v.drive) continue;
    const path = new Path(v.drive.path);
    const a = rearPoint(v, m.ini);
    const b = rearPoint(v, m.col);
    const d = Math.abs(path.project(b.x, b.z) - path.project(a.x, a.z));
    const fb = v.drive.events.filter((x) => x.action === 'frenar' && x.t < 0).sort((x, y) => x.t - y.t)[0];
    const auto = v.drive.speedAuto !== false;
    legs.push({ v, d, brake: fb ? -fb.t : 0, auto, vRef: (auto ? defaultSpeed(world, roads, v, m.ini) : v.drive.speed) / 3.6 });
  }
  if (legs.length) {
    // duración común: la que necesita el más lento en llegar de ① a ②
    let T = Math.max(...legs.map((l) => l.d / Math.max(0.5, l.vRef)));
    T = Math.min(30, Math.max(0.8, T));
    for (const l of legs) {
      if (!l.auto) continue;
      // con frenada antes del choque recorre algo menos: se compensa la velocidad inicial
      const dec = 0.8 * 9.81;
      const tb = Math.min(l.brake, T);
      const v0 = (l.d + 0.5 * dec * tb * tb) / T;
      l.v.drive!.speed = Math.max(3, Math.round(v0 * 3.6));
    }
    const start = Math.max(-30, Math.min(-1, Math.floor((-T - 0.25) * 4) / 4));
    const end = Math.max(p.timeline?.end ?? 4, 4);
    p.timeline = { start, end };
  }
}

/** Instante en que el vehículo pasa más cerca de una posición (según la simulación). */
export function timeAtMark(world: World, e: VehicleEntity, pose: Pose): number | null {
  const sv = world.sim?.vehicles.get(e.id);
  if (!sv) return null;
  let best: { t: number; d: number } | null = null;
  for (const f of sv.frames) {
    const d = Math.hypot(f.x - pose.x, f.z - pose.z);
    if (!best || d < best.d) best = { t: f.t, d };
  }
  return best && best.d < 3 ? best.t : null;
}
