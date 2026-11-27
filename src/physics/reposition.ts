import { newId } from '../model/store';
import type { CtrlPoint, VehicleEntity } from '../model/types';
import type { World } from '../scene/world';
import { Path } from './path';
import { frameAt, simulate } from './sim';

/** Posición del centro del vehículo y rumbo (grados). */
export interface Pose {
  x: number;
  z: number;
  h: number;
}

export interface RepositionResult {
  phase: 'estatico' | 'antes' | 'impacto' | 'despues' | 'reposo';
  message: string;
  /** Hay que buscar velocidades que reproduzcan la nueva posición (ajuste a los hechos). */
  needsFit: boolean;
}

const fwd = (hDeg: number): [number, number] => {
  const h = (hDeg * Math.PI) / 180;
  return [Math.sin(h), -Math.cos(h)];
};
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
const fmtT = (t: number) => (Math.abs(t) < 0.005 ? 't = 0' : `t = ${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(2).replace('.', ',')} s`);

/** Distancia del centro geométrico al eje trasero (la ruta la sigue el eje trasero). */
function rearOffset(e: VehicleEntity) {
  const sp = e.spec;
  if (!sp.batalla) return 0;
  return sp.volD + sp.batalla - sp.L / 2;
}
function rearOf(e: VehicleEntity, p: Pose): CtrlPoint {
  const [fx, fz] = fwd(p.h);
  const d = rearOffset(e);
  return { x: p.x - fx * d, z: p.z - fz * d, h: null };
}

/**
 * Rehace la ruta alrededor del punto donde estaba el vehículo para que pase por la nueva posición.
 * Si además se ha girado, añade dos puntos que fijan la dirección.
 */
function reroute(e: VehicleEntity, from: Pose, to: Pose) {
  const d = e.drive!;
  const path = new Path(d.path);
  const oldRear = rearOf(e, from);
  const newRear = rearOf(e, to);
  // se ordena por dónde cae la nueva posición sobre la ruta y se quitan los puntos de su entorno
  // (y los del entorno de la antigua si apenas se ha desplazado a lo largo de la ruta)
  const sOld = path.project(oldRear.x, oldRear.z);
  const sNew = path.project(newRear.x, newRear.z);
  const cs = d.path.map((p) => path.project(p.x, p.z));
  const near = angDiff(to.h, from.h) > 4 ? 12 : 7;
  const lo = Math.abs(sNew - sOld) < near ? Math.min(sNew, sOld) - near : sNew - near;
  const hi = Math.abs(sNew - sOld) < near ? Math.max(sNew, sOld) + near : sNew + near;
  const before = d.path.filter((_, i) => cs[i] < lo);
  const after = d.path.filter((_, i) => cs[i] > hi);
  const mid: CtrlPoint[] = [];
  const [fx, fz] = fwd(to.h);
  // si se ha girado, la ruta llega y sale en la nueva dirección (tramo recto de ±8 m)
  const turned = angDiff(to.h, from.h) > 4;
  if (turned) mid.push({ x: newRear.x - fx * 8, z: newRear.z - fz * 8, h: null }, { x: newRear.x - fx * 4, z: newRear.z - fz * 4, h: null });
  mid.push(newRear);
  if (turned || !after.length) mid.push({ x: newRear.x + fx * 4, z: newRear.z + fz * 4, h: null });
  if (turned) mid.push({ x: newRear.x + fx * 8, z: newRear.z + fz * 8, h: null });
  let pts = [...before, ...mid, ...after];
  // nunca menos de dos puntos ni puntos casi duplicados
  pts = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.5);
  if (pts.length < 2) pts.push({ x: newRear.x + fx * 20, z: newRear.z + fz * 20, h: null });
  d.path = pts;
}

/**
 * Velocidad inicial (km/h) con la que el vehículo, con su ruta y acciones, está en la posición
 * indicada en el instante t (bisección sobre simulaciones del vehículo solo). null si no hay ninguna.
 */
function speedToBeAt(world: World, e: VehicleEntity, t: number, to: Pose): { speed: number; err: number } {
  const input = world.simInput([e]);
  input.end = Math.max(t + 0.02, input.start + 0.02);
  const path = new Path(e.drive!.path);
  const target = rearOf(e, to);
  const sTarget = path.project(target.x, target.z);
  const off = rearOffset(e);
  const gap = (v: number) => {
    const veh = { ...e, drive: { ...e.drive!, speed: v } };
    const r = simulate({ ...input, vehicles: [veh] });
    const f = frameAt(r.vehicles.get(e.id)!, t);
    const [fx, fz] = fwd(f.h);
    return path.project(f.x - fx * off, f.z - fz * off) - sTarget;
  };
  let lo = 2;
  let hi = 220;
  let glo = gap(lo);
  let ghi = gap(hi);
  if (Math.sign(glo) === Math.sign(ghi)) return Math.abs(glo) < Math.abs(ghi) ? { speed: lo, err: glo } : { speed: hi, err: ghi };
  for (let i = 0; i < 16 && hi - lo > 0.2; i++) {
    const mid = (lo + hi) / 2;
    const g = gap(mid);
    if (Math.sign(g) === Math.sign(glo)) {
      lo = mid;
      glo = g;
    } else {
      hi = mid;
      ghi = g;
    }
  }
  const speed = Math.abs(glo) < Math.abs(ghi) ? lo : hi;
  return { speed: Math.round(speed * 10) / 10, err: Math.min(Math.abs(glo), Math.abs(ghi)) };
}

/**
 * El conductor sigue la ruta con algo de retraso: desplaza los puntos insertados por la desviación
 * lateral que queda en el instante t (la longitudinal la resuelve la velocidad).
 */
function correctLateral(world: World, e: VehicleEntity, t: number, to: Pose, speed: number, err: number, resolveSpeed: boolean) {
  const d = e.drive!;
  for (let it = 0; it < 2 && Math.abs(err) < 3; it++) {
    const veh = { ...e, drive: { ...d, speed } };
    const input = world.simInput([veh]);
    input.end = Math.max(t + 0.02, input.start + 0.02);
    const f = frameAt(simulate({ ...input, vehicles: [veh] }).vehicles.get(e.id)!, t);
    const [fx, fz] = fwd(to.h);
    const rx = -fz;
    const rz = fx;
    const lat = (to.x - f.x) * rx + (to.z - f.z) * rz;
    if (Math.abs(lat) < 0.15) break;
    const target = rearOf(e, to);
    let k = -1;
    let best = Infinity;
    d.path.forEach((q, i) => {
      const dd = Math.hypot(q.x - target.x, q.z - target.z);
      if (dd < best) {
        best = dd;
        k = i;
      }
    });
    if (k < 0 || best > 3 + Math.abs(lat)) break;
    const c = { ...d.path[k] };
    for (const q of d.path)
      if (Math.hypot(q.x - c.x, q.z - c.z) < 4.5) {
        q.x += rx * lat;
        q.z += rz * lat;
      }
    if (resolveSpeed) ({ speed, err } = speedToBeAt(world, e, t, to));
  }
  return { speed, err };
}

/** Añade (o sustituye, si ya hay una en ese instante) una posición observada. */
function pin(e: VehicleEntity, t: number, to: Pose) {
  const pins = (e.pins ??= []);
  const i = pins.findIndex((p) => Math.abs(p.t - t) < 0.05);
  const p = { id: i >= 0 ? pins[i].id : newId('pin'), t: Math.round(t * 100) / 100, x: to.x, z: to.z, h: ((to.h % 360) + 360) % 360 };
  if (i >= 0) pins[i] = p;
  else pins.push(p);
  pins.sort((a, b) => a.t - b.t);
}

/**
 * Recoloca un vehículo en el instante t y adapta la reconstrucción:
 * - antes del choque: la ruta pasa por la nueva posición y la velocidad se ajusta para estar ahí en t;
 * - en el instante del impacto: además se desplaza el punto de colisión;
 * - después del choque: queda como posición observada (la física decide el movimiento tras el
 *   impacto, así que hay que ajustar velocidades para reproducirla);
 * - en reposo: es la posición final observada.
 * Modifica la entidad (y el punto de colisión) en el sitio: llamar dentro de una edición del store.
 */
export function repositionVehicle(world: World, e: VehicleEntity, t: number, to: Pose): RepositionResult {
  const p = world.store.project;
  const sv = world.sim?.vehicles.get(e.id) ?? null;
  const tc = sv?.firstContact ?? null;
  const tr = sv?.restTime ?? null;
  const from: Pose = sv ? frameAt(sv, t) : { x: e.x, z: e.z, h: e.heading };

  if (!world.isDriven(e)) {
    if (tc === null || t <= tc + 0.01) {
      e.x = Math.round(to.x * 100) / 100;
      e.z = Math.round(to.z * 100) / 100;
      e.heading = Math.round((((to.h % 360) + 360) % 360) * 10) / 10;
      return { phase: 'estatico', message: `${e.label}: vehículo parado recolocado.`, needsFit: false };
    }
    pin(e, t, to);
    return { phase: 'despues', message: `${e.label}: posición observada en ${fmtT(t)} (tras ser golpeado).`, needsFit: true };
  }
  const d = e.drive!;

  if (tc !== null && t > tc + 0.03) {
    if (tr !== null && t >= tr - 0.01) {
      e.x = to.x;
      e.z = to.z;
      e.heading = ((to.h % 360) + 360) % 360;
      d.showFinal = true;
      return { phase: 'reposo', message: `${e.label}: nueva posición final observada.`, needsFit: true };
    }
    pin(e, t, to);
    return { phase: 'despues', message: `${e.label}: posición observada en ${fmtT(t)}, después del choque.`, needsFit: true };
  }

  // antes del choque (o en el instante del impacto)
  reroute(e, from, to);
  if (d.sync && p.impact && Math.abs(t) < 0.06) {
    const L = e.spec.L / 2;
    const [ox, oz] = fwd(from.h);
    const [nx, nz] = fwd(to.h);
    p.impact = { x: p.impact.x + (to.x + nx * L) - (from.x + ox * L), z: p.impact.z + (to.z + nz * L) - (from.z + oz * L) };
    correctLateral(world, e, t, to, d.speed, 0, false);
    return { phase: 'impacto', message: `${e.label}: ruta y punto de colisión desplazados; los vehículos sincronizados llegan al nuevo punto en t = 0.`, needsFit: false };
  }
  const old = d.speed;
  let speed: number;
  let err: number;
  ({ speed, err } = speedToBeAt(world, e, t, to));
  ({ speed, err } = correctLateral(world, e, t, to, speed, err, true));
  if (Math.abs(err) > 3) {
    // ninguna velocidad razonable lo deja ahí: se conserva la velocidad y solo cambia la ruta
    d.speed = old;
    return {
      phase: 'antes',
      message: `${e.label}: ruta rehecha por la nueva posición, pero con su ruta y acciones no puede estar ahí en ${fmtT(t)} a ninguna velocidad razonable (queda a ${Math.abs(err).toFixed(1).replace('.', ',')} m); se mantiene ${Math.round(old)} km/h.`,
      needsFit: false,
    };
  }
  d.speed = speed;
  let tail = Math.abs(err) > 1 ? ` Queda a ${Math.abs(err).toFixed(1).replace('.', ',')} m de la posición pedida.` : '';
  // en marcha no puede girar en seco: avisar si el rumbo conseguido difiere del pedido
  {
    const input = world.simInput([e]);
    input.end = Math.max(t + 0.02, input.start + 0.02);
    const f = frameAt(simulate({ ...input, vehicles: [e] }).vehicles.get(e.id)!, t);
    const dh = angDiff(f.h, to.h);
    if (dh > 8) tail += ` En marcha no puede girar en seco: en ese instante su rumbo es ${Math.round(f.h)}° (pediste ${Math.round(to.h)}°); su ruta ya sigue la nueva dirección.`;
  }
  return {
    phase: 'antes',
    message: `${e.label}: ruta rehecha por la nueva posición; velocidad ${Math.round(old)} → ${Math.round(speed)} km/h para estar ahí en ${fmtT(t)}.${tail}`,
    needsFit: false,
  };
}
