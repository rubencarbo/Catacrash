import * as THREE from 'three';
import type { MotionKey, VehicleEntity } from '../model/types';

/**
 * Trayectoria de un vehículo a partir de sus posiciones clave.
 * - El recorrido es una curva suave (Catmull-Rom centrípeta) que pasa por las claves.
 * - Entre dos claves la distancia recorrida sigue un perfil cúbico (Hermite) que respeta
 *   la velocidad en cada clave (fijada por el usuario o deducida de tiempos y distancias).
 * - El rumbo sigue la tangente; si una clave fija el rumbo, la diferencia se interpola
 *   (permite trompos y derrapes tras el impacto).
 */

export interface Pose {
  x: number;
  z: number;
  heading: number;
  /** m/s */
  speed: number;
  /** Índice del tramo (−1 antes de la primera clave). */
  seg: number;
  marks: boolean;
}

export interface SegmentInfo {
  t0: number;
  t1: number;
  /** Longitud recorrida (m). */
  length: number;
  /** Velocidades en los extremos (m/s). */
  v0: number;
  v1: number;
  /** Aceleración media (m/s², negativa = frenada). */
  accel: number;
  marks: boolean;
}

export interface Motion {
  keys: MotionKey[];
  segments: SegmentInfo[];
  /** Velocidad en cada clave (m/s) y si fue deducida. */
  keySpeeds: { v: number; vOut: number; derived: boolean }[];
  pose(t: number): Pose;
  /** Puntos del recorrido para dibujarlo. */
  path(step?: number): THREE.Vector3[];
}

const norm360 = (a: number) => ((a % 360) + 360) % 360;
const angDiff = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

export function buildMotion(e: VehicleEntity): Motion | null {
  const keys = [...(e.motion ?? [])].sort((a, b) => a.t - b.t);
  if (keys.length === 0) return null;
  if (keys.length === 1) {
    const k = keys[0];
    const pose: Pose = { x: k.x, z: k.z, heading: k.heading ?? e.heading, speed: 0, seg: 0, marks: false };
    return { keys, segments: [], keySpeeds: [{ v: 0, vOut: 0, derived: true }], pose: () => pose, path: () => [] };
  }

  // Curva y tabla de longitudes
  const pts = keys.map((k) => new THREE.Vector3(k.x, 0, k.z));
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
  const SUB = 40;
  const N = (keys.length - 1) * SUB;
  const uTab: number[] = [];
  const sTab: number[] = [0];
  let prev = curve.getPoint(0);
  uTab.push(0);
  for (let i = 1; i <= N; i++) {
    const u = i / N;
    const p = curve.getPoint(u);
    sTab.push(sTab[i - 1] + Math.hypot(p.x - prev.x, p.z - prev.z));
    uTab.push(u);
    prev = p;
  }
  const keyS = keys.map((_, k) => sTab[k * SUB]);
  const uAtS = (s: number) => {
    let lo = 0;
    let hi = sTab.length - 1;
    if (s <= 0) return 0;
    if (s >= sTab[hi]) return 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (sTab[m] < s) lo = m;
      else hi = m;
    }
    const f = (s - sTab[lo]) / Math.max(1e-9, sTab[hi] - sTab[lo]);
    return uTab[lo] + (uTab[hi] - uTab[lo]) * f;
  };

  // Velocidades en las claves
  const segAvg: number[] = [];
  for (let k = 0; k < keys.length - 1; k++) {
    const dt = Math.max(1e-3, keys[k + 1].t - keys[k].t);
    segAvg.push((keyS[k + 1] - keyS[k]) / dt);
  }
  const hasOut = (k: MotionKey) => k.speedOut !== undefined && k.speedOut !== null && Number.isFinite(k.speedOut);
  const keySpeeds = keys.map((k, i) => {
    let r: { v: number; derived: boolean };
    if (k.speed !== null && Number.isFinite(k.speed)) r = { v: Math.max(0, k.speed / 3.6), derived: false };
    else if (i === 0) r = { v: segAvg[0], derived: true };
    else if (i === keys.length - 1) r = { v: segAvg[i - 1], derived: true };
    else if (hasOut(keys[i - 1]) || hasOut(k)) r = { v: segAvg[i - 1], derived: true };
    else r = { v: (segAvg[i - 1] + segAvg[i]) / 2, derived: true };
    return { ...r, vOut: hasOut(k) ? Math.max(0, (k.speedOut as number) / 3.6) : r.v };
  });

  const segments: SegmentInfo[] = segAvg.map((_, k) => {
    const dt = Math.max(1e-3, keys[k + 1].t - keys[k].t);
    return {
      t0: keys[k].t,
      t1: keys[k + 1].t,
      length: keyS[k + 1] - keyS[k],
      v0: keySpeeds[k].vOut,
      v1: keySpeeds[k + 1].v,
      accel: (keySpeeds[k + 1].v - keySpeeds[k].vOut) / dt,
      marks: keys[k].marks,
    };
  });

  // Desfase de rumbo respecto a la tangente en cada clave
  const tangentAt = (u: number) => {
    const tg = curve.getTangent(Math.min(1, Math.max(0, u)));
    return norm360((Math.atan2(tg.x, -tg.z) * 180) / Math.PI);
  };
  const offsets = keys.map((k, i) => (k.heading === null ? 0 : angDiff(tangentAt(i / (keys.length - 1)), k.heading)));

  const sAt = (k: number, t: number) => {
    const dt = Math.max(1e-3, keys[k + 1].t - keys[k].t);
    const L = keyS[k + 1] - keyS[k];
    const tau = Math.min(1, Math.max(0, (t - keys[k].t) / dt));
    // Hermite con tangentes limitadas para que la distancia nunca retroceda
    const m0 = Math.min(keySpeeds[k].vOut * dt, 3 * L);
    const m1 = Math.min(keySpeeds[k + 1].v * dt, 3 * L);
    const t2 = tau * tau;
    const t3 = t2 * tau;
    const s = (t3 - 2 * t2 + tau) * m0 + (-2 * t3 + 3 * t2) * L + (t3 - t2) * m1;
    const ds = ((3 * t2 - 4 * tau + 1) * m0 + (-6 * t2 + 6 * tau) * L + (3 * t2 - 2 * tau) * m1) / dt;
    return { s: keyS[k] + Math.min(L, Math.max(0, s)), v: Math.max(0, ds) };
  };

  const pose = (t: number): Pose => {
    if (t <= keys[0].t) {
      const k = keys[0];
      return { x: k.x, z: k.z, heading: norm360(tangentAt(0) + offsets[0]), speed: 0, seg: -1, marks: false };
    }
    const last = keys.length - 1;
    if (t >= keys[last].t) {
      const k = keys[last];
      return { x: k.x, z: k.z, heading: norm360(tangentAt(1) + offsets[last]), speed: 0, seg: last, marks: false };
    }
    let k = 0;
    while (k < last - 1 && t > keys[k + 1].t) k++;
    const { s, v } = sAt(k, t);
    const u = uAtS(s);
    const p = curve.getPoint(u);
    const tau = (t - keys[k].t) / Math.max(1e-3, keys[k + 1].t - keys[k].t);
    const off = offsets[k] + angDiff(offsets[k], offsets[k + 1]) * tau;
    return { x: p.x, z: p.z, heading: norm360(tangentAt(u) + off), speed: v, seg: k, marks: keys[k].marks };
  };

  return {
    keys,
    segments,
    keySpeeds,
    pose,
    path: (step = 0.5) => {
      const out: THREE.Vector3[] = [];
      const total = sTab[sTab.length - 1];
      const n = Math.max(2, Math.ceil(total / step));
      for (let i = 0; i <= n; i++) out.push(curve.getPoint(uAtS((total * i) / n)));
      return out;
    },
  };
}

/** Coeficiente de adherencia de referencia según el estado del firme. */
export function frictionFor(wet: boolean) {
  return wet ? 0.5 : 0.8;
}

/** Avisos de coherencia física de una trayectoria. */
export function motionWarnings(m: Motion, wet: boolean): string[] {
  const mu = frictionFor(wet);
  const amax = mu * 9.81;
  const out: string[] = [];
  m.segments.forEach((s, i) => {
    if (s.accel < -amax * 1.05)
      out.push(`Tramo ${i + 1}: frena a ${(-s.accel).toFixed(1)} m/s², más de lo posible con el firme ${wet ? 'mojado' : 'seco'} (máx. ≈ ${amax.toFixed(1)} m/s²).`);
    if (s.accel > 6) out.push(`Tramo ${i + 1}: acelera a ${s.accel.toFixed(1)} m/s², excesivo para un turismo (≈ 3–5 m/s²).`);
    const vmax = Math.max(s.v0, s.v1) * 3.6;
    if (vmax > 220) out.push(`Tramo ${i + 1}: velocidad de ${vmax.toFixed(0)} km/h, revisa tiempos o distancias.`);
  });
  return out;
}

/** Distancia de detención teórica desde v (m/s) con adherencia mu. */
export function stoppingDistance(v: number, mu: number) {
  return (v * v) / (2 * mu * 9.81);
}
