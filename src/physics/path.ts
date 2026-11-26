import * as THREE from 'three';
import type { CtrlPoint } from '../model/types';

/** Ruta en planta: polilínea suave con distancia acumulada; se prolonga en línea recta por ambos extremos. */
export class Path {
  xs: number[] = [];
  zs: number[] = [];
  ss: number[] = [];
  length = 0;

  constructor(points: CtrlPoint[]) {
    const pts = points.map((p) => new THREE.Vector3(p.x, 0, p.z));
    let dense: THREE.Vector3[];
    if (pts.length >= 3) {
      const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      dense = c.getSpacedPoints(Math.max(8, Math.ceil(c.getLength() / 0.5)));
    } else if (pts.length === 2) {
      const n = Math.max(2, Math.ceil(pts[0].distanceTo(pts[1]) / 0.5));
      dense = Array.from({ length: n + 1 }, (_, i) => pts[0].clone().lerp(pts[1], i / n));
    } else {
      dense = [pts[0] ?? new THREE.Vector3(), (pts[0] ?? new THREE.Vector3()).clone().add(new THREE.Vector3(0, 0, -1))];
    }
    let s = 0;
    dense.forEach((p, i) => {
      if (i > 0) s += Math.hypot(p.x - dense[i - 1].x, p.z - dense[i - 1].z);
      this.xs.push(p.x);
      this.zs.push(p.z);
      this.ss.push(s);
    });
    this.length = s;
  }

  private seg(s: number) {
    const n = this.ss.length;
    if (s <= 0) return 0;
    if (s >= this.length) return n - 2;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.ss[m] <= s) lo = m;
      else hi = m;
    }
    return lo;
  }

  /** Punto a la distancia s (fuera de la ruta se prolonga en línea recta). */
  point(s: number): [number, number] {
    const i = this.seg(s);
    const ds = this.ss[i + 1] - this.ss[i] || 1;
    const t = (s - this.ss[i]) / ds;
    return [this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t, this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t];
  }

  /** Dirección unitaria de avance en s. */
  tangent(s: number): [number, number] {
    const i = this.seg(s);
    const dx = this.xs[i + 1] - this.xs[i];
    const dz = this.zs[i + 1] - this.zs[i];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  }

  /** Proyección local (cerca de sHint): solo los tramos vecinos; para seguir la ruta paso a paso. */
  projectNear(x: number, z: number, sHint: number): number {
    const n = this.xs.length;
    const i0 = this.seg(sHint);
    let best = Infinity;
    let bs = sHint;
    for (let i = Math.max(0, i0 - 2); i <= Math.min(n - 2, i0 + 3); i++) {
      const ax = this.xs[i];
      const az = this.zs[i];
      const dx = this.xs[i + 1] - ax;
      const dz = this.zs[i + 1] - az;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      if (i > 0) t = Math.max(0, t);
      if (i < n - 2) t = Math.min(1, t);
      const px = ax + dx * t;
      const pz = az + dz * t;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < best) {
        best = d;
        bs = this.ss[i] + t * Math.sqrt(l2);
      }
    }
    return bs;
  }

  /** Proyección de un punto sobre la ruta (incluida su prolongación). */
  project(x: number, z: number): number {
    let best = Infinity;
    let bs = 0;
    const n = this.xs.length;
    for (let i = 0; i < n - 1; i++) {
      const ax = this.xs[i];
      const az = this.zs[i];
      const dx = this.xs[i + 1] - ax;
      const dz = this.zs[i + 1] - az;
      const l2 = dx * dx + dz * dz || 1;
      let t = ((x - ax) * dx + (z - az) * dz) / l2;
      if (i > 0) t = Math.max(0, t);
      if (i < n - 2) t = Math.min(1, t);
      const px = ax + dx * t;
      const pz = az + dz * t;
      const d = (x - px) ** 2 + (z - pz) ** 2;
      if (d < best) {
        best = d;
        bs = this.ss[i] + t * Math.sqrt(l2);
      }
    }
    return bs;
  }
}
