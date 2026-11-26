import type { CtrlPoint, RoadEntity } from '../model/types';
import type { World } from '../scene/world';

/**
 * Ruta por el centro del carril derecho de la carretera más cercana, en el sentido del rumbo
 * del vehículo (circulación por la derecha). Si no hay carretera cerca, una recta.
 */
export function laneRoute(world: World, roads: RoadEntity[], x: number, z: number, headingDeg: number, back = 0, ahead = 160): CtrlPoint[] {
  const h = (headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  let best: { road: RoadEntity; i: number; d: number } | null = null;
  for (const r of roads) {
    const S = world.samples.get(r.id);
    if (!S) continue;
    for (let i = 0; i < S.length; i++) {
      const d = Math.hypot(S[i].x - x, S[i].z - z);
      if (d < 20 && (!best || d < best.d)) best = { road: r, i, d };
    }
  }
  if (!best) {
    return [-back, ahead / 3, (2 * ahead) / 3, ahead].map((s) => ({ x: x + fx * s, z: z + fz * s, h: null }));
  }
  const S = world.samples.get(best.road.id)!;
  const q = S[best.i];
  const along = q.tx * fx + q.tz * fz >= 0 ? 1 : -1;
  const prof = best.road.profile;
  // primer carril a la derecha del sentido de marcha
  const bands = along > 0 ? prof.right : prof.left;
  const first = bands.find((b) => b.type === 'carril') ?? bands[0];
  const lane = (first?.width ?? 3.5) / 2;
  const off = along > 0 ? lane : -lane; // + = derecha del sentido del trazado
  const out: CtrlPoint[] = [];
  const s0 = q.s - along * back;
  const s1 = q.s + along * ahead;
  const step = 8 * along;
  for (let s = s0; along > 0 ? s <= s1 : s >= s1; s += step) {
    if (s < 0 || s > S[S.length - 1].s) continue;
    let k = 0;
    while (k < S.length - 2 && S[k + 1].s < s) k++;
    const p = S[k];
    out.push({ x: p.x - p.tz * off, z: p.z + p.tx * off, h: null });
  }
  if (out.length < 2) return [-back, 0, ahead].map((s) => ({ x: x + fx * s, z: z + fz * s, h: null }));
  return out;
}
