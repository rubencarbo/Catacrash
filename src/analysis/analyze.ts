import * as THREE from 'three';
import type { PropEntity, RoadEntity, VehicleEntity } from '../model/types';
import { laneRoute } from '../physics/lane';
import { Path } from '../physics/path';
import { frameAt, MU, simulate, type Frame, type SimInput, type SimResult } from '../physics/sim';
import type { World } from '../scene/world';

/**
 * Análisis automático del accidente a partir de la simulación: qué hizo cada vehículo, qué
 * factores intervinieron (velocidad, invasión del carril, curva, visibilidad, reacción) y si el
 * choque se habría evitado con otra conducta (simulaciones alternativas).
 *
 * Orientativo: no sustituye a un informe pericial.
 */

const G = 9.81;
/** Tiempo de percepción y reacción de referencia (s). */
export const T_REACT = 1.0;

export interface Limit {
  value: number;
  source: string;
}

export interface VehAnalysis {
  id: string;
  label: string;
  name: string;
  color: string;
  dir: string;
  road: string | null;
  v0: number;
  /** Primer contacto (s) y velocidad entonces (km/h). */
  contactT: number | null;
  vImpact: number | null;
  dv: number | null;
  limit: Limit | null;
  excess: number | null;
  /** Invasión del carril contrario antes del choque. */
  invasion: { max: number; t0: number; atContact: number } | null;
  /** Salida de la calzada por su derecha antes del choque. */
  offRoad: { max: number; t0: number } | null;
  curve: { R: number; vCrit: number; vComfort: number; grip: number } | null;
  /** Primera acción del conductor antes del choque. */
  action: { t: number; text: string; v: number } | null;
  /** Momento desde el que puede ver al otro vehículo (hasta el choque). */
  sight: { other: string; t: number; dist: number; v: number; fromStart: boolean } | null;
  reaction: number | null;
  stop: { dStop: number; dAvail: number; could: boolean } | null;
  /** Señal de prioridad (STOP / ceda el paso) que encontró antes del choque. */
  priority: { sign: string; vMin: number; vPass: number; t: number; obeyed: boolean } | null;
  rest: { t: number | null; x: number; z: number; distFromImpact: number | null } | null;
  skid: number;
}

export interface Event {
  t: number;
  veh: string | null;
  text: string;
  kind: 'inicio' | 'accion' | 'invasion' | 'visibilidad' | 'contacto' | 'reposo' | 'senal' | 'salida';
}

export interface Factor {
  level: 'alto' | 'medio' | 'bajo' | 'info';
  text: string;
}

export interface Alternative {
  veh: string;
  title: string;
  avoided: boolean;
  text: string;
}

export interface Analysis {
  ok: boolean;
  message?: string;
  conditions: string[];
  vehicles: VehAnalysis[];
  events: Event[];
  factors: Factor[];
  alternatives: Alternative[];
  narrative: string[];
  conclusion: string[];
  pair: [string, string] | null;
}

const DIRS = ['el norte', 'el noreste', 'el este', 'el sureste', 'el sur', 'el suroeste', 'el oeste', 'el noroeste'];
const dirText = (h: number) => DIRS[Math.round((((h % 360) + 360) % 360) / 45) % 8];
const kmh = (v: number) => Math.round(v * 3.6);
const n1 = (v: number) => v.toFixed(1).replace('.', ',');
const ts = (t: number) => (Math.abs(t) < 0.005 ? 't = 0' : `t = ${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(2).replace('.', ',')} s`);
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
/** «frena a fondo» → «Frenó a fondo» (para la narración en pasado). */
const past = (t: string) =>
  t
    .replace(/^frena/, 'Frenó')
    .replace(/^gira/, 'Giró')
    .replace(/^acelera/, 'Aceleró')
    .replace(/^suelta/, 'Soltó')
    .replace(/^vuelve/, 'Volvió');

/** Posición respecto a la carretera más cercana. */
interface RoadPos {
  road: RoadEntity;
  /** Desplazamiento lateral (m) respecto al eje, positivo a la derecha del sentido de marcha. */
  lat: (x: number, z: number) => number;
  lanes: number; // anchura de carriles del propio sentido
  shoulder: number; // carriles + arcén
  q: { x: number; z: number; tx: number; tz: number; s: number };
}

function roadPos(world: World, roads: RoadEntity[], x: number, z: number, h: number): RoadPos | null {
  // la vía por la que circula: cercana y con su misma dirección (en un cruce, no la transversal)
  const hr0 = (h * Math.PI) / 180;
  const fx0 = Math.sin(hr0);
  const fz0 = -Math.cos(hr0);
  let best: { road: RoadEntity; i: number; d: number } | null = null;
  for (const r of roads) {
    const S = world.samples.get(r.id);
    if (!S) continue;
    for (let i = 0; i < S.length; i++) {
      const dist = Math.hypot(S[i].x - x, S[i].z - z);
      if (dist > 25) continue;
      const d = dist + 15 * (1 - Math.abs(S[i].tx * fx0 + S[i].tz * fz0));
      if (!best || d < best.d) best = { road: r, i, d };
    }
  }
  if (!best) return null;
  const S = world.samples.get(best.road.id)!;
  // proyección precisa sobre el tramo más cercano
  const i = Math.min(best.i, S.length - 2);
  const q = S[i];
  const hr = (h * Math.PI) / 180;
  const along = q.tx * Math.sin(hr) + q.tz * -Math.cos(hr) >= 0 ? 1 : -1;
  const prof = best.road.profile;
  const side = along > 0 ? prof.right : prof.left;
  let lanes = 0;
  let shoulder = 0;
  for (const b of side) {
    if (b.type === 'carril') lanes += b.width;
    if (b.type === 'carril' || b.type === 'arcen' || b.type === 'aparcamiento' || b.type === 'carril_bici') shoulder += b.width;
    else break;
  }
  const nx = -q.tz;
  const nz = q.tx;
  return { road: best.road, lanes: lanes || 3.5, shoulder: shoulder || lanes || 3.5, q, lat: (px, pz) => along * ((px - q.x) * nx + (pz - q.z) * nz) };
}

function corners(f: Frame, L: number, W: number): [number, number][] {
  const h = (f.h * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  return [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ].map(([a, b]) => [f.x + (fx * a * L) / 2 + (rx * b * W) / 2, f.z + (fz * a * L) / 2 + (rz * b * W) / 2]);
}

/** Radio de la carretera alrededor de un punto (m); Infinity en recta. */
function roadRadius(world: World, road: RoadEntity, x: number, z: number): number {
  const S = world.samples.get(road.id);
  if (!S || S.length < 3) return Infinity;
  let k = 0;
  let bd = Infinity;
  S.forEach((q, i) => {
    const d = (q.x - x) ** 2 + (q.z - z) ** 2;
    if (d < bd) {
      bd = d;
      k = i;
    }
  });
  const sk = S[k].s;
  const a = S.find((q) => q.s >= sk - 15) ?? S[0];
  const b = [...S].reverse().find((q) => q.s <= sk + 15) ?? S[S.length - 1];
  const da = Math.atan2(a.tz, a.tx);
  const db = Math.atan2(b.tz, b.tx);
  let d = db - da;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const len = b.s - a.s;
  if (len < 5 || Math.abs(d) < 1e-3) return Infinity;
  return len / Math.abs(d);
}

/** Línea de visión entre dos puntos: relieve (por muestreo) y objetos (árboles, edificios, muros…). */
function makeSight(world: World, surfaceH: (x: number, z: number) => number) {
  const occluders: THREE.Object3D[] = [];
  for (const e of world.store.project.entities) {
    if (e.kind !== 'prop' && e.kind !== 'linear') continue;
    const o = world.objects.get(e.id);
    if (o && o.visible) occluders.push(o);
  }
  const rc = new THREE.Raycaster();
  const a = new THREE.Vector3();
  const d = new THREE.Vector3();
  return (p: THREE.Vector3, q: THREE.Vector3): boolean => {
    const dist = p.distanceTo(q);
    const n = Math.ceil(dist / 1.0);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = p.x + (q.x - p.x) * t;
      const y = p.y + (q.y - p.y) * t;
      const z = p.z + (q.z - p.z) * t;
      if (y < surfaceH(x, z) + 0.05) return false;
    }
    a.copy(p);
    d.copy(q).sub(p).normalize();
    rc.set(a, d);
    rc.far = dist - 0.5;
    rc.near = 0.3;
    const hit = rc.intersectObjects(occluders, true).find((h) => (h.object as THREE.Mesh).isMesh && !(h.object.userData?.noOcclude));
    return !hit;
  };
}

/** Vehículos para simulaciones alternativas: sin sincronizar, saliendo del mismo punto de su ruta. */
function frozen(vehicles: VehicleEntity[], sim: SimResult): VehicleEntity[] {
  return vehicles.map((v) =>
    v.drive
      ? { ...v, drive: { ...v.drive, sync: false, startS: sim.syncOffsets.get(v.id) ?? v.drive.startS ?? 0, events: v.drive.events.map((e) => ({ ...e })) } }
      : v,
  );
}

export function analyze(world: World): Analysis {
  const store = world.store;
  const p = store.project;
  const sim = world.sim;
  const empty = (message: string): Analysis => ({ ok: false, message, conditions: [], vehicles: [], events: [], factors: [], alternatives: [], narrative: [], conclusion: [], pair: null });
  if (!sim) return empty('No hay simulación: dale movimiento al menos a un vehículo (inspector del vehículo → «Darle movimiento»).');
  const input: SimInput = world.simInput();
  input.end = Math.max(input.end, 12);
  const vehicles = p.entities.filter((e): e is VehicleEntity => e.kind === 'vehicle' && !e.hidden);
  const roads = p.entities.filter((e): e is RoadEntity => e.kind === 'road');
  const byId = new Map(vehicles.map((v) => [v.id, v]));
  const lbl = (id: string) => byId.get(id)?.label || byId.get(id)?.name || id;
  const muRoad = MU.asfalto[p.env.wet ? 1 : 0];

  // ---- condiciones ----
  const conditions: string[] = [];
  const elev = (world.vp.sunInfo.elevation * 180) / Math.PI;
  const hh = Math.floor(p.env.hour);
  const mm = Math.round((p.env.hour - hh) * 60);
  const lamps = p.entities.filter((e) => e.kind === 'prop' && (e as PropEntity).type === 'farola').length;
  const light = elev > 6 ? 'de día' : elev > -6 ? 'al amanecer o anochecer (luz escasa)' : lamps ? 'de noche, con alumbrado público en la zona' : 'de noche, sin alumbrado público';
  conditions.push(`Hora ${hh}:${String(mm).padStart(2, '0')}, ${light}.`);
  conditions.push(p.env.wet ? `Firme mojado (adherencia del asfalto ≈ ${n1(MU.asfalto[1])}).` : `Firme seco (adherencia del asfalto ≈ ${n1(MU.asfalto[0])}).`);
  if (p.env.fog > 0.05) conditions.push(`Niebla (${Math.round(p.env.fog * 100)} %): visibilidad reducida.`);

  // ---- señales de velocidad ----
  const speedSigns = p.entities.filter((e): e is PropEntity => e.kind === 'prop' && e.type === 'senal' && e.params.senal === 'velocidad');
  const prioSigns = p.entities.filter((e): e is PropEntity => e.kind === 'prop' && e.type === 'senal' && (e.params.senal === 'stop' || e.params.senal === 'ceda'));
  const stopLines = p.entities.filter((e): e is PropEntity => e.kind === 'prop' && e.type === 'linea_detencion');

  // ---- par principal: primer contacto entre dos vehículos ----
  const vv = sim.contacts.filter((c) => byId.has(c.b) && c.peakForce > 2000).sort((a, b) => a.t0 - b.t0);
  const pair: [string, string] | null = vv.length ? [vv[0].a, vv[0].b] : null;
  const impactPt = vv.length ? { x: vv[0].x, z: vv[0].z } : p.impact ?? null;

  const sight = makeSight(world, input.surfaceH);
  const eye = (v: VehicleEntity, f: Frame) => {
    const h = (f.h * Math.PI) / 180;
    const x = f.x + Math.sin(h) * v.spec.L * 0.05 - Math.cos(h) * v.spec.W * 0.2;
    const z = f.z - Math.cos(h) * v.spec.L * 0.05 - Math.sin(h) * v.spec.W * 0.2;
    return new THREE.Vector3(x, input.surfaceH(x, z) + Math.min(2.6, Math.max(1.0, v.spec.H - 0.3)), z);
  };
  const targets = (v: VehicleEntity, f: Frame) => {
    const pts = [[0, 0], ...corners(f, v.spec.L, v.spec.W).slice(0, 2).map(([x, z]) => [x - f.x, z - f.z])];
    return pts.map(([dx, dz]) => {
      const x = f.x + dx * 0.8;
      const z = f.z + dz * 0.8;
      return new THREE.Vector3(x, input.surfaceH(x, z) + Math.max(0.5, v.spec.H * 0.6), z);
    });
  };

  const events: Event[] = [];
  const out: VehAnalysis[] = [];
  for (const v of vehicles) {
    const sv = sim.vehicles.get(v.id);
    if (!sv || !v.drive) continue;
    const F = sv.frames;
    const f0 = F[0];
    const tc = sv.firstContact;
    const tEnd = tc ?? 0;
    const pre = F.filter((f) => f.t <= tEnd + 1e-6);
    const rp0 = roadPos(world, roads, f0.x, f0.z, f0.h);
    const a: VehAnalysis = {
      id: v.id,
      label: v.label || v.name,
      name: v.spec.marca ? `${v.spec.marca} ${v.spec.modelo}` : v.name,
      color: v.color,
      dir: dirText(f0.h),
      road: rp0?.road.name ?? null,
      v0: kmh(f0.v),
      contactT: tc,
      vImpact: sv.impactSpeed !== null ? kmh(sv.impactSpeed) : null,
      dv: null,
      limit: null,
      excess: null,
      invasion: null,
      offRoad: null,
      curve: null,
      action: null,
      sight: null,
      reaction: null,
      stop: null,
      priority: null,
      rest: null,
      skid: 0,
    };
    const c0 = sim.contacts.find((c) => (c.a === v.id || c.b === v.id) && c.t0 === tc);
    if (c0) a.dv = kmh(c0.a === v.id ? c0.dvA : c0.dvB);
    events.push({ t: f0.t, veh: v.id, kind: 'inicio', text: `${a.label} circula hacia ${a.dir}${a.road ? ` por ${a.road}` : ''} a ${a.v0} km/h.` });

    // límite de velocidad: última señal R-301 que encara antes del choque, o el genérico de la vía
    const path = new Path(v.drive.path);
    const sAt = (f: Frame) => path.project(f.x, f.z);
    const sLimit = sAt(pre[pre.length - 1] ?? f0);
    let sign: { s: number; val: number; name: string } | null = null;
    for (const sg of speedSigns) {
      const s = path.project(sg.x, sg.z);
      const [px, pz] = path.point(s);
      const [tx, tz] = path.tangent(s);
      const hdg = (Math.atan2(tx, -tz) * 180) / Math.PI;
      if (Math.hypot(px - sg.x, pz - sg.z) > 14 || angDiff(hdg, sg.rot) > 75 || s > sLimit) continue;
      const val = Number(String(sg.params.valor).replace(/\D/g, ''));
      if (val > 0 && (!sign || s > sign.s)) sign = { s, val, name: sg.name };
    }
    if (sign) a.limit = { value: sign.val, source: `señal R-301 de ${sign.val} km/h` };
    else if (rp0?.road.limit) a.limit = { value: rp0.road.limit, source: `límite de ${rp0.road.name}` };
    const vMax = Math.max(...pre.map((f) => f.v)) * 3.6;
    if (a.limit) a.excess = Math.round(vMax - a.limit.value);

    // posición en la calzada antes del choque
    for (const f of pre) {
      const rp = roadPos(world, roads, f.x, f.z, f.h);
      if (!rp) continue;
      // cruzando otra vía (en un cruce) no se invade su carril contrario: solo cuenta circulando por ella
      const hr = (f.h * Math.PI) / 180;
      if (Math.abs(rp.q.tx * Math.sin(hr) - rp.q.tz * Math.cos(hr)) < 0.8) continue;
      const lats = corners(f, v.spec.L, v.spec.W).map(([x, z]) => rp.lat(x, z));
      const inv = -Math.min(...lats);
      if (inv > 0.2) {
        if (!a.invasion) {
          a.invasion = { max: inv, t0: f.t, atContact: 0 };
          events.push({ t: f.t, veh: v.id, kind: 'invasion', text: `${a.label} empieza a invadir el carril contrario.` });
        }
        a.invasion.max = Math.max(a.invasion.max, inv);
      }
      const off = Math.max(...lats) - rp.shoulder;
      if (off > 0.3) {
        if (!a.offRoad) {
          a.offRoad = { max: off, t0: f.t };
          events.push({ t: f.t, veh: v.id, kind: 'salida', text: `${a.label} se sale de la calzada por su derecha.` });
        }
        a.offRoad.max = Math.max(a.offRoad.max, off);
      }
    }
    // señales de prioridad (STOP, ceda el paso) que encara antes del choque
    for (const sg of prioSigns) {
      const s0 = path.project(sg.x, sg.z);
      const [px, pz] = path.point(s0);
      const [tx, tz] = path.tangent(s0);
      const hdg = (Math.atan2(tx, -tz) * 180) / Math.PI;
      if (Math.hypot(px - sg.x, pz - sg.z) > 9 || angDiff(hdg, sg.rot) > 60) continue;
      // punto de detención: la línea de detención que tenga delante (si la hay), si no la señal
      const lines = stopLines
        .map((ln) => {
          const sl = path.project(ln.x, ln.z);
          const [lx, lz] = path.point(sl);
          return Math.hypot(lx - ln.x, lz - ln.z) < 4 && sl >= s0 - 3 && sl <= s0 + 15 ? sl : null;
        })
        .filter((x): x is number => x !== null);
      const sStop = lines.length ? Math.max(...lines) : s0;
      if (sLimit < sStop - 0.5) continue; // no llegó a la señal antes del choque
      const near = pre.filter((f) => {
        const sf = sAt(f);
        return sf >= sStop - 12 && sf <= sStop + 1;
      });
      if (!near.length) continue;
      const vMin = Math.min(...near.map((f) => f.v)) * 3.6;
      const code = String(sg.params.senal);
      const fPass = near.reduce((b, f) => (Math.abs(sAt(f) - sStop) < Math.abs(sAt(b) - sStop) ? f : b));
      a.priority = { sign: code === 'stop' ? 'STOP' : 'ceda el paso', vMin: Math.round(vMin), vPass: Math.round(fPass.v * 3.6), t: fPass.t, obeyed: code === 'stop' ? vMin < 3 : vMin < 15 };
      if (!a.priority.obeyed) events.push({ t: fPass.t, veh: v.id, kind: 'senal', text: code === 'stop' ? `${a.label} rebasa la línea de STOP sin detenerse, a ${a.priority.vPass} km/h.` : `${a.label} entra en el cruce sin ceder el paso, a ${a.priority.vPass} km/h.` });
    }
    if (a.invasion && pre.length) {
      const f = pre[pre.length - 1];
      const rp = roadPos(world, roads, f.x, f.z, f.h);
      if (rp) a.invasion.atContact = Math.max(0, -Math.min(...corners(f, v.spec.L, v.spec.W).map(([x, z]) => rp.lat(x, z))));
    }

    // curva en el tramo previo al choque
    const fApp = frameAt(sv, Math.max(f0.t, tEnd - 1));
    const rpA = roadPos(world, roads, fApp.x, fApp.z, fApp.h);
    if (rpA) {
      const R = roadRadius(world, rpA.road, fApp.x, fApp.z);
      if (R < 600) {
        const ayMax = Math.max(0, ...pre.filter((f) => f.t >= tEnd - 3).map((f) => Math.abs(f.ay)));
        a.curve = { R, vCrit: Math.sqrt(muRoad * G * R) * 3.6, vComfort: Math.sqrt(3 * R) * 3.6, grip: ayMax / (muRoad * G) };
      }
    }

    // acciones del conductor
    const names = (e: { action: string; value: number }) =>
      e.action === 'frenar'
        ? e.value >= 0.95
          ? 'frena a fondo'
          : `frena (${Math.round(e.value * 100)} %)`
        : e.action === 'girar'
          ? `gira el volante ${Math.abs(e.value)}° a la ${e.value >= 0 ? 'derecha' : 'izquierda'}`
          : e.action === 'acelerar'
            ? 'acelera'
            : e.action === 'soltar'
              ? 'suelta los pedales'
              : 'vuelve a su trayectoria';
    for (const e of [...v.drive.events].sort((x, y) => x.t - y.t)) {
      events.push({ t: e.t, veh: v.id, kind: 'accion', text: `${a.label} ${names(e)}${tc !== null && e.t > tc ? ' (tras el primer impacto: sin efecto, ha perdido el control)' : ''}.` });
      if (!a.action && (tc === null || e.t <= tc) && (e.action === 'frenar' || e.action === 'girar'))
        a.action = { t: e.t, text: names(e), v: kmh(frameAt(sv, e.t).v) };
    }

    // reposo y huellas
    const last = F[F.length - 1];
    a.rest = { t: sv.restTime, x: last.x, z: last.z, distFromImpact: impactPt ? Math.hypot(last.x - impactPt.x, last.z - impactPt.z) : null };
    if (sv.restTime !== null) events.push({ t: sv.restTime, veh: v.id, kind: 'reposo', text: `${a.label} queda detenido${a.rest.distFromImpact !== null ? ` a ${n1(a.rest.distFromImpact)} m del punto de colisión` : ''}.` });
    for (const m of sv.marks) {
      let Lm = 0;
      for (let i = 1; i < m.pts.length; i++) Lm += Math.hypot(m.pts[i].x - m.pts[i - 1].x, m.pts[i].z - m.pts[i - 1].z);
      a.skid = Math.max(a.skid, Lm);
    }
    out.push(a);
  }

  // ---- visibilidad entre los dos vehículos del choque principal ----
  if (pair) {
    const tc = vv[0].t0;
    for (const [me, other] of [pair, [pair[1], pair[0]] as [string, string]]) {
      const A = byId.get(me)!;
      const B = byId.get(other)!;
      const sa = sim.vehicles.get(me)!;
      const sb = sim.vehicles.get(other)!;
      const step = 0.1;
      let tVis: number | null = null;
      for (let t = tc - step; t >= sim.start - 1e-6; t -= step) {
        const fa = frameAt(sa, t);
        const fb = frameAt(sb, t);
        const e = eye(A, fa);
        const seen = targets(B, fb).some((q) => sight(e, q));
        if (!seen) break;
        tVis = t;
      }
      const a = out.find((x) => x.id === me);
      if (!a || tVis === null) continue;
      const fa = frameAt(sa, tVis);
      const fb = frameAt(sb, tVis);
      a.sight = { other, t: tVis, dist: Math.hypot(fa.x - fb.x, fa.z - fb.z), v: kmh(fa.v), fromStart: tVis <= sim.start + 0.11 };
      if (!a.sight.fromStart)
        events.push({ t: tVis, veh: me, kind: 'visibilidad', text: `${a.label} puede ver a ${lbl(other)} (a ${Math.round(a.sight.dist)} m).` });
      if (a.action && a.action.t >= tVis) a.reaction = a.action.t - tVis;
      // ¿podía detenerse antes de llegar al punto de colisión con una reacción normal?
      let dAvail = 0;
      const F = sa.frames.filter((f) => f.t >= tVis && f.t <= tc);
      for (let i = 1; i < F.length; i++) dAvail += Math.hypot(F[i].x - F[i - 1].x, F[i].z - F[i - 1].z);
      const vv0 = fa.v;
      const dStop = vv0 * T_REACT + (vv0 * vv0) / (2 * muRoad * 0.95 * G);
      a.stop = { dStop, dAvail, could: dStop <= dAvail };
    }
  }

  // contactos
  const seen = new Set<string>();
  for (const c of sim.contacts) {
    if (c.peakForce < 2000) continue;
    const key = `${c.a}|${c.bName}|${Math.round(c.t0 * 2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isV = byId.has(c.b);
    events.push({
      t: c.t0,
      veh: c.a,
      kind: 'contacto',
      text: isV
        ? `Choque ${lbl(c.a)} – ${lbl(c.b)}: Δv ${kmh(c.dvA)} / ${kmh(c.dvB)} km/h, aplastamiento ${Math.round(c.crushA * 100)} / ${Math.round(c.crushB * 100)} cm.`
        : `${lbl(c.a)} golpea ${c.bName.toLowerCase().startsWith('el ') || c.bName.toLowerCase().startsWith('la ') ? c.bName : `«${c.bName}»`} (Δv ${kmh(c.dvA)} km/h).`,
    });
  }
  events.sort((x, y) => x.t - y.t || (x.kind === 'inicio' ? -1 : 1));

  // ---- factores ----
  const factors: Factor[] = [];
  for (const a of out) {
    if (a.excess !== null && a.limit) {
      if (a.excess > 20) factors.push({ level: 'alto', text: `${a.label} superaba el límite: hasta ${a.limit.value + a.excess} km/h donde la ${a.limit.source} permite ${a.limit.value} (+${a.excess} km/h).` });
      else if (a.excess > 5) factors.push({ level: 'medio', text: `${a.label} superaba ligeramente el límite: ${a.limit.value + a.excess} km/h con ${a.limit.source} (+${a.excess} km/h).` });
    } else if (!a.limit) factors.push({ level: 'info', text: `No consta el límite de velocidad para ${a.label}: añade una señal R-301 o el límite genérico de la vía.` });
    if (a.invasion)
      factors.push({
        level: a.invasion.max > 0.5 ? 'alto' : 'medio',
        text: `${a.label} invadió el carril contrario desde ${ts(a.invasion.t0)}, hasta ${n1(a.invasion.max)} m${a.invasion.atContact > 0.05 ? ` (${n1(a.invasion.atContact)} m en el momento del choque)` : ''}.`,
      });
    if (a.priority && !a.priority.obeyed)
      factors.push({
        level: 'alto',
        text: a.priority.sign === 'STOP' ? `${a.label} no se detuvo en el STOP: la velocidad mínima al llegar a la línea fue de ${a.priority.vMin} km/h y la rebasó a ${a.priority.vPass} km/h.` : `${a.label} no cedió el paso: entró en el cruce a ${a.priority.vPass} km/h.`,
      });
    else if (a.priority) factors.push({ level: 'info', text: `${a.label} se detuvo en el ${a.priority.sign} (velocidad mínima ${a.priority.vMin} km/h).` });
    if (a.offRoad) factors.push({ level: 'medio', text: `${a.label} se salió de la calzada por su derecha (${n1(a.offRoad.max)} m) desde ${ts(a.offRoad.t0)}.` });
    if (a.curve && a.contactT !== null) {
      const vNow = a.v0;
      if (a.curve.grip > 0.7)
        factors.push({ level: 'alto', text: `En la curva (radio ≈ ${Math.round(a.curve.R)} m) ${a.label} llegó a usar el ${Math.round(a.curve.grip * 100)} % de la adherencia disponible: al límite de perder el control.` });
      else if (vNow > a.curve.vComfort + 10)
        factors.push({ level: 'medio', text: `${a.label} entró en una curva de radio ≈ ${Math.round(a.curve.R)} m a ${vNow} km/h; la velocidad habitual para ese radio es de unos ${Math.round(a.curve.vComfort)} km/h (límite físico ≈ ${Math.round(a.curve.vCrit)} km/h).` });
    }
    // la visibilidad solo es un factor si fue escasa para detenerse a tiempo
    if (a.sight && !a.sight.fromStart && a.stop && a.sight.dist < a.stop.dStop * 1.5)
      factors.push({
        level: a.stop.could ? 'medio' : 'alto',
        text: `Visibilidad escasa: ${a.label} solo pudo ver a ${lbl(a.sight.other)} desde ${ts(a.sight.t)}, a ${Math.round(a.sight.dist)} m (por el trazado, el relieve u obstáculos).`,
      });
    if (a.sight) {
      const avail = (a.contactT ?? 0) - a.sight.t;
      if (a.reaction !== null) {
        const r = a.reaction;
        factors.push({
          level: r > 1.5 ? 'medio' : 'info',
          text: `${a.label} reaccionó (${a.action!.text}) ${n1(r)} s después de poder ver a ${lbl(a.sight.other)}: ${r < 0.75 ? 'reacción rápida' : r <= 1.5 ? 'dentro de lo habitual (0,75–1,5 s)' : 'reacción tardía (más de 1,5 s)'}.`,
        });
      } else if (!a.action)
        factors.push({ level: avail > 1.5 ? 'medio' : 'info', text: `${a.label} no frenó ni maniobró antes del choque${avail > 0 ? `, y tuvo ${n1(avail)} s desde que pudo ver a ${lbl(a.sight.other)}` : ''}.` });
      if (a.stop)
        factors.push({
          level: 'info',
          text: a.stop.could
            ? `Con una reacción normal (${n1(T_REACT)} s) ${a.label} podía haberse detenido en ${Math.round(a.stop.dStop)} m, antes de llegar al punto de colisión (${Math.round(a.stop.dAvail)} m).`
            : `Aun reaccionando con normalidad, ${a.label} necesitaba ${Math.round(a.stop.dStop)} m para detenerse y solo tenía ${Math.round(a.stop.dAvail)} m hasta el punto de colisión.`,
        });
    }
  }
  if (p.env.wet) factors.push({ level: 'medio', text: 'El firme mojado alarga las distancias de frenado y reduce la velocidad máxima en curva.' });
  if (elev <= 6) factors.push({ level: elev > -6 ? 'medio' : lamps ? 'info' : 'medio', text: `Condiciones de luz: ${light}.` });
  if (p.env.fog > 0.05) factors.push({ level: 'medio', text: 'La niebla redujo la visibilidad.' });

  // ---- evitabilidad (simulaciones alternativas) ----
  const alternatives: Alternative[] = [];
  if (pair) {
    const base = frozen(input.vehicles, sim);
    const baseRes = simulate({ ...input, vehicles: base });
    const hit = (res: SimResult) => res.contacts.find((c) => ((c.a === pair[0] && c.b === pair[1]) || (c.a === pair[1] && c.b === pair[0])) && c.peakForce > 2000) ?? null;
    const reproduced = !!hit(baseRes);
    const describe = (res: SimResult) => {
      const c = hit(res);
      if (!c) {
        const parts = pair.map((id) => {
          const f = res.vehicles.get(id)!.frames;
          const l = f[f.length - 1];
          return l.v < 0.2 ? `${lbl(id)} se detiene` : `${lbl(id)} sigue a ${kmh(l.v)} km/h`;
        });
        const other = res.contacts.filter((x) => x.peakForce > 2000 && pair.includes(x.a));
        const worst = new Map<string, number>();
        for (const o of other) {
          const f = frameAt(res.vehicles.get(o.a)!, o.t0 - 0.02);
          const key = `${lbl(o.a)} golpearía «${o.bName}»`;
          worst.set(key, Math.max(worst.get(key) ?? 0, kmh(Math.hypot(f.vx, f.vz))));
        }
        const hits = [...worst].map(([k, v]) => `${k} a ${v} km/h`);
        return { avoided: true, text: `No habría habido choque entre ${lbl(pair[0])} y ${lbl(pair[1])} (${parts.join('; ')}).${hits.length ? ` Pero ${hits.join('; ')}.` : ''}` };
      }
      const orig = vv[0];
      const dvA = c.a === orig.a ? c.dvA : c.dvB;
      const dvB = c.a === orig.a ? c.dvB : c.dvA;
      return {
        avoided: false,
        text: `El choque se habría producido igualmente, con Δv ${kmh(dvA)} / ${kmh(dvB)} km/h (en la reconstrucción: ${kmh(orig.dvA)} / ${kmh(orig.dvB)} km/h)${kmh(dvA) + kmh(dvB) < kmh(orig.dvA) + kmh(orig.dvB) - 8 ? ': bastante menos grave' : ''}.`,
      };
    };
    if (reproduced) {
      for (const a of out) {
        if (!pair.includes(a.id)) continue;
        const veh = base.find((x) => x.id === a.id)!;
        // 1) a la velocidad permitida
        if (a.limit && a.excess !== null && a.excess > 5) {
          const alt = base.map((x) => (x.id === a.id ? { ...x, drive: { ...x.drive!, speed: Math.min(x.drive!.speed, a.limit!.value) } } : x));
          const d = describe(simulate({ ...input, vehicles: alt }));
          alternatives.push({ veh: a.id, title: `Si ${a.label} hubiera circulado a ${a.limit.value} km/h`, ...d });
        }
        // 2) por su carril
        if (a.invasion && a.invasion.max > 0.3) {
          const f0 = sim.vehicles.get(a.id)!.frames[0];
          const len = new Path(veh.drive!.path).length + 60;
          const route = laneRoute(world, roads, f0.x, f0.z, f0.h, 0, len);
          // sin invasión, el otro conductor no tendría que esquivar: se quitan sus maniobras posteriores a verlo
          const otherId = pair[0] === a.id ? pair[1] : pair[0];
          const oa = out.find((x) => x.id === otherId);
          const tSeen = oa?.sight?.t ?? -Infinity;
          const alt = base.map((x) =>
            x.id === a.id
              ? { ...x, drive: { ...x.drive!, path: route, startS: 0 } }
              : x.id === otherId
                ? { ...x, drive: { ...x.drive!, events: x.drive!.events.filter((e) => e.t < tSeen) } }
                : x,
          );
          const d = describe(simulate({ ...input, vehicles: alt }));
          alternatives.push({ veh: a.id, title: `Si ${a.label} se hubiera mantenido en su carril (y ${lbl(otherId)}, sin nada que esquivar, siguiera sin frenar ni girar)`, ...d });
        }
        // 3) reacción a tiempo: frenada a fondo un tiempo normal después de poder ver al otro
        if (a.sight && (a.reaction === null || a.reaction > T_REACT + 0.1)) {
          const tB = a.sight.t + T_REACT;
          if (tB < (a.contactT ?? 0)) {
            const alt = base.map((x) => {
              if (x.id !== a.id) return x;
              const evs = x.drive!.events.filter((e) => e.action !== 'frenar');
              evs.push({ id: 'alt-brake', t: tB, action: 'frenar', value: 1 });
              return { ...x, drive: { ...x.drive!, events: evs } };
            });
            const d = describe(simulate({ ...input, vehicles: alt }));
            alternatives.push({ veh: a.id, title: `Si ${a.label} hubiera frenado a fondo ${n1(T_REACT)} s después de poder ver a ${lbl(a.sight.other)} (${ts(tB)})`, ...d });
          }
        }
      }
    }
  }

  // ---- narración ----
  const narrative: string[] = [];
  for (const a of out) {
    const parts: string[] = [];
    parts.push(`${a.label} (${a.name}) circulaba hacia ${a.dir}${a.road ? ` por ${a.road}` : ''} a ${a.v0} km/h${a.limit ? `, en un tramo con ${a.limit.source}` : ''}.`);
    if (a.curve) parts.push(`Se aproximaba a una curva de radio ≈ ${Math.round(a.curve.R)} m.`);
    if (a.invasion) parts.push(`Invadió el carril contrario desde ${ts(a.invasion.t0)} (hasta ${n1(a.invasion.max)} m).`);
    if (a.sight && !a.sight.fromStart) parts.push(`Pudo ver a ${lbl(a.sight.other)} desde ${ts(a.sight.t)}, a ${Math.round(a.sight.dist)} m.`);
    if (a.action) parts.push(`${past(a.action.text)} en ${ts(a.action.t)}, a ${a.action.v} km/h.`);
    else if (a.contactT !== null) parts.push('No frenó ni maniobró antes del impacto.');
    if (a.contactT !== null && a.vImpact !== null) parts.push(`Impactó en ${ts(a.contactT)} a ${a.vImpact} km/h${a.dv !== null ? ` (Δv ${a.dv} km/h)` : ''}.`);
    if (a.skid > 2) parts.push(`Dejó huellas de neumático de hasta ${n1(a.skid)} m.`);
    if (a.rest && a.rest.t !== null) parts.push(`Quedó detenido en ${ts(a.rest.t)}${a.rest.distFromImpact !== null ? `, a ${n1(a.rest.distFromImpact)} m del punto de colisión` : ''}.`);
    narrative.push(parts.join(' '));
  }

  // ---- conclusión (prudente) ----
  const conclusion: string[] = [];
  // rumbo de cada vehículo del par en el instante del choque (para saber si venían cruzados o de frente)
  const hAtContact = (id: string) => {
    const sv = sim.vehicles.get(id);
    const t = sv?.firstContact;
    return sv && t !== null && t !== undefined ? frameAt(sv, t - 0.02).h : null;
  };
  const crossing = (id: string) => {
    if (!pair || !pair.includes(id)) return null;
    const other = pair[0] === id ? pair[1] : pair[0];
    const h1 = hAtContact(id);
    const h2 = hAtContact(other);
    return h1 !== null && h2 !== null ? { other, ang: angDiff(h1, h2) } : null;
  };
  // la invasión del carril contrario importa cuando el otro venía de frente por esa vía (no en un cruce)
  const invaders = out.filter((a) => a.invasion && a.invasion.max > 0.3 && (() => {
    if (!pair?.includes(a.id)) return true;
    const h1 = hAtContact(a.id);
    const h2 = hAtContact(pair[0] === a.id ? pair[1] : pair[0]);
    return h1 === null || h2 === null || angDiff(h1, h2) > 120;
  })());
  const speeders = out.filter((a) => a.excess !== null && a.excess > 5);
  const late = out.filter((a) => a.reaction !== null && a.reaction > 1.5);
  const violators = out.filter((a) => a.priority && (!a.priority.obeyed || ((crossing(a.id)?.ang ?? 0) > 45 && (crossing(a.id)?.ang ?? 0) < 135)));
  for (const a of violators) {
    const cr = crossing(a.id);
    const vs = cr ? ` a ${lbl(cr.other)}, que circulaba por la vía preferente` : '';
    if (a.priority!.sign === 'STOP')
      conclusion.push(
        a.priority!.obeyed
          ? `El factor determinante parece ser que ${a.label} se detuvo en el STOP pero no cedió el paso${vs}.`
          : `El factor determinante parece ser que ${a.label} no respetó la señal de STOP: rebasó la línea a ${a.priority!.vPass} km/h sin detenerse${vs ? ` y sin ceder el paso${vs}` : ''}.`,
      );
    else conclusion.push(`El factor determinante parece ser que ${a.label} no cedió el paso${vs} (entró a ${a.priority!.vPass} km/h).`);
  }
  if (violators.length) {
    // con una infracción de prioridad clara, la invasión de quien la comete es consecuencia, no causa
  } else if (invaders.length === 1) conclusion.push(`El factor determinante parece ser la invasión del carril contrario por ${invaders[0].label}.`);
  else if (invaders.length > 1 && !violators.length) conclusion.push(`Ambos vehículos ocupaban parte del carril contrario.`);
  if (speeders.length) conclusion.push(`${speeders.map((a) => a.label).join(' y ')} ${speeders.length > 1 ? 'circulaban' : 'circulaba'} por encima del límite, lo que ${invaders.some((i) => speeders.includes(i)) ? 'probablemente contribuyó a la invasión en la curva y ' : ''}redujo el margen para evitar el choque.`);
  if (late.length) conclusion.push(`${late.map((a) => a.label).join(' y ')} ${late.length > 1 ? 'reaccionaron' : 'reaccionó'} tarde.`);
  const avoidedBy = alternatives.filter((x) => x.avoided);
  if (avoidedBy.length) conclusion.push(`Según las simulaciones alternativas, el choque se habría evitado ${avoidedBy.map((x) => x.title.replace(/^Si /, 'si ').replace(/ \(.*\)$/, '')).join(', o ')}.`);
  else if (alternatives.length) conclusion.push('Ninguna de las alternativas simuladas evita el choque por sí sola.');
  if (!conclusion.length) conclusion.push('Sin un factor claramente determinante con los datos disponibles.');

  return { ok: true, conditions, vehicles: out, events, factors, alternatives, narrative, conclusion, pair };
}
