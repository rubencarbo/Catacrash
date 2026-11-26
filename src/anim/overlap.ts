import type { VehicleEntity } from '../model/types';
import type { World } from '../scene/world';

type Poly = [number, number][];

function rect(e: VehicleEntity, x: number, z: number, headingDeg: number): Poly {
  const a = (headingDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const w = e.spec.W / 2;
  const l = e.spec.L / 2;
  return [
    [-w, -l],
    [w, -l],
    [w, l],
    [-w, l],
  ].map(([lx, lz]) => [x + lx * c - lz * s, z + lx * s + lz * c]);
}

/** Solape (m) entre dos rectángulos por ejes separadores; 0 si no se tocan. */
function overlap(p: Poly, q: Poly): number {
  let min = Infinity;
  for (const poly of [p, q]) {
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = poly[i];
      const [x1, z1] = poly[(i + 1) % 4];
      let ax = -(z1 - z0);
      let az = x1 - x0;
      const l = Math.hypot(ax, az) || 1;
      ax /= l;
      az /= l;
      const pr = (P: Poly) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (const [x, z] of P) {
          const d = x * ax + z * az;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
        return [lo, hi];
      };
      const [a0, a1] = pr(p);
      const [b0, b1] = pr(q);
      const ov = Math.min(a1, b1) - Math.max(a0, b0);
      if (ov <= 0) return 0;
      min = Math.min(min, ov);
    }
  }
  return min;
}

export interface OverlapReport {
  a: string;
  b: string;
  from: number;
  to: number;
  max: number;
}

/**
 * Recorre la animación y detecta intervalos en los que dos vehículos se atraviesan
 * (más de 15 cm en planta). El contacto en el instante del impacto es normal y no se cuenta.
 */
export function findOverlaps(world: World, vehicles: VehicleEntity[], start: number, end: number, step = 0.04): OverlapReport[] {
  const out: OverlapReport[] = [];
  const animated = vehicles.filter((v) => (v.motion?.length ?? 0) > 1);
  if (!animated.length || vehicles.length < 2) return out;
  const poseAt = (v: VehicleEntity, t: number) => {
    const m = world.motionOf(v);
    return m ? m.pose(t) : { x: v.x, z: v.z, heading: v.heading };
  };
  for (let i = 0; i < vehicles.length; i++)
    for (let j = i + 1; j < vehicles.length; j++) {
      const A = vehicles[i];
      const B = vehicles[j];
      if (!animated.includes(A) && !animated.includes(B)) continue;
      let cur: OverlapReport | null = null;
      for (let t = start; t <= end + 1e-9; t += step) {
        if (Math.abs(t) < 0.12) continue; // contacto del impacto
        const pa = poseAt(A, t);
        const pb = poseAt(B, t);
        const ov = overlap(rect(A, pa.x, pa.z, pa.heading), rect(B, pb.x, pb.z, pb.heading));
        if (ov > 0.15) {
          if (!cur) cur = { a: A.label || A.name, b: B.label || B.name, from: t, to: t, max: ov };
          cur.to = t;
          cur.max = Math.max(cur.max, ov);
        } else if (cur) {
          out.push(cur);
          cur = null;
        }
      }
      if (cur) out.push(cur);
    }
  return out;
}
