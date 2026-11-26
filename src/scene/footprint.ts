import type { ProfileLayout } from './profile';
import type { PathSample } from './spline';

/**
 * Huella en planta de una superficie transitable (carretera, glorieta).
 * Sirve para resolver cruces: recortar la vía de menor rango, interrumpir marcas
 * y enlazar cotas en los extremos.
 */
export interface Footprint {
  id: string;
  rank: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** ¿El punto está dentro (con un margen opcional)? */
  inside(x: number, z: number, margin?: number): boolean;
  /** Cota de la superficie en el punto (válida dentro de la huella). */
  height(x: number, z: number): number;
}

interface Seg {
  ax: number;
  az: number;
  ay: number;
  dx: number;
  dz: number;
  dy: number;
  l2: number;
  nx: number;
  nz: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  first: boolean;
  last: boolean;
}

export function roadFootprint(id: string, rank: number, S: PathSample[], L: ProfileLayout): Footprint {
  const reach = Math.max(L.halfL, L.halfR) + 1;
  const segs: Seg[] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let k = 0; k < S.length - 1; k++) {
    const a = S[k];
    const b = S[k + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-9) continue;
    const l = Math.sqrt(l2);
    const sg: Seg = {
      ax: a.x,
      az: a.z,
      ay: a.y,
      dx,
      dz,
      dy: b.y - a.y,
      l2,
      nx: -dz / l,
      nz: dx / l,
      minX: Math.min(a.x, b.x) - reach,
      maxX: Math.max(a.x, b.x) + reach,
      minZ: Math.min(a.z, b.z) - reach,
      maxZ: Math.max(a.z, b.z) + reach,
      first: k === 0,
      last: k === S.length - 2,
    };
    segs.push(sg);
    minX = Math.min(minX, sg.minX);
    maxX = Math.max(maxX, sg.maxX);
    minZ = Math.min(minZ, sg.minZ);
    maxZ = Math.max(maxZ, sg.maxZ);
  }
  const nearest = (x: number, z: number) => {
    let best: { d: number; o: number; y: number } | null = null;
    for (const s of segs) {
      if (x < s.minX || x > s.maxX || z < s.minZ || z > s.maxZ) continue;
      let t = ((x - s.ax) * s.dx + (z - s.az) * s.dz) / s.l2;
      if ((s.first && t < 0) || (s.last && t > 1)) continue;
      t = Math.max(0, Math.min(1, t));
      const cx = s.ax + s.dx * t;
      const cz = s.az + s.dz * t;
      const d = Math.hypot(x - cx, z - cz);
      if (!best || d < best.d) best = { d, o: (x - cx) * s.nx + (z - cz) * s.nz, y: s.ay + s.dy * t };
    }
    return best;
  };
  return {
    id,
    rank,
    minX,
    maxX,
    minZ,
    maxZ,
    inside(x, z, margin = 0) {
      if (x < minX || x > maxX || z < minZ || z > maxZ) return false;
      const n = nearest(x, z);
      if (!n) return false;
      return n.d <= (n.o < 0 ? L.halfL : L.halfR) + margin;
    },
    height(x, z) {
      const n = nearest(x, z);
      if (!n) return 0;
      const half = n.o < 0 ? L.halfL : L.halfR;
      const o = Math.max(-half, Math.min(half, n.o));
      return n.y + L.heightAt(o);
    },
  };
}

export function circleFootprint(id: string, rank: number, cx: number, cz: number, R: number, height: (r: number) => number): Footprint {
  return {
    id,
    rank,
    minX: cx - R,
    maxX: cx + R,
    minZ: cz - R,
    maxZ: cz + R,
    inside(x, z, margin = 0) {
      return Math.hypot(x - cx, z - cz) <= R + margin;
    },
    height(x, z) {
      return height(Math.min(R, Math.hypot(x - cx, z - cz)));
    },
  };
}

/** Predicado «está dentro de alguna de estas huellas». */
export function insideAny(list: Footprint[], margin = 0) {
  if (!list.length) return () => false;
  return (x: number, z: number) => {
    for (const f of list) if (f.inside(x, z, margin)) return true;
    return false;
  };
}
