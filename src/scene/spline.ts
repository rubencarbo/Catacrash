import * as THREE from 'three';
import type { CtrlPoint } from '../model/types';

/** Muestra de un trazado: posición, distancia acumulada y tangente horizontal unitaria. */
export interface PathSample {
  x: number;
  y: number;
  z: number;
  s: number;
  tx: number;
  tz: number;
}

/**
 * Muestrea un trazado a paso aproximadamente constante.
 * - smooth: curva Catmull-Rom centrípeta (carreteras, ríos); si no, polilínea (muros, vallas).
 * - heightOf: cota en cada punto de control; se interpola suavemente a lo largo de la curva.
 */
export function samplePath(
  points: CtrlPoint[],
  heightOf: (p: CtrlPoint) => number,
  step = 0.5,
  smooth = true,
): PathSample[] {
  if (points.length < 2) return [];
  const v3 = points.map((p) => new THREE.Vector3(p.x, heightOf(p), p.z));
  const out: PathSample[] = [];

  if (smooth && points.length > 2) {
    const curve = new THREE.CatmullRomCurve3(v3, false, 'centripetal');
    const len = curve.getLength();
    const n = Math.max(2, Math.ceil(len / step));
    const pts = curve.getSpacedPoints(n);
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (i > 0) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      out.push({ x: p.x, y: p.y, z: p.z, s, tx: dx / l, tz: dz / l });
    }
    return out;
  }

  // Polilínea: se muestrea cada tramo; en los vértices se repite el punto con la nueva tangente.
  let s = 0;
  for (let i = 0; i < v3.length - 1; i++) {
    const a = v3[i];
    const b = v3[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz);
    if (l < 1e-6) continue;
    const n = Math.max(1, Math.ceil(l / step));
    for (let k = 0; k <= n; k++) {
      if (k === 0 && out.length) {
        const last = out[out.length - 1];
        out.push({ ...last, tx: dx / l, tz: dz / l });
        continue;
      }
      const t = k / n;
      out.push({
        x: a.x + dx * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + dz * t,
        s: s + l * t,
        tx: dx / l,
        tz: dz / l,
      });
    }
    s += l;
  }
  return out;
}

/** Longitud horizontal de una lista de muestras. */
export function pathLength(samples: PathSample[]) {
  return samples.length ? samples[samples.length - 1].s : 0;
}
