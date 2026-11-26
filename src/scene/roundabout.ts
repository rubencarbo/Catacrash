import * as THREE from 'three';
import type { RoundaboutEntity } from '../model/types';
import { circleFootprint, insideAny, type Footprint } from './footprint';
import { GeoBuf } from './geobuf';
import { MAT } from './materials';
import type { RadialShaper } from './terrain';

const CURB = 0.15;

/** Radios característicos de la glorieta. */
export function rbRadii(e: RoundaboutEntity) {
  const Ro = e.radius;
  const Ri = Math.max(1, Ro - e.width);
  const Ra = Math.max(0.5, Ri - e.apron);
  const Rout = e.outer === 'ninguno' ? Ro : Ro + e.outerWidth;
  return { Ro, Ri, Ra, Rout };
}

/** Cota relativa al centro según el radio. */
export function rbHeight(e: RoundaboutEntity) {
  const { Ro, Ri, Ra } = rbRadii(e);
  const road = (r: number) => -(r - Ri) * 0.02; // 2 % hacia fuera
  return (r: number) => {
    if (r <= Ra) {
      const t = r / Ra;
      if (e.island === 'pavimento') return CURB;
      return CURB + (e.island === 'hierba' ? 0.5 : 0.25) * (1 - t * t);
    }
    if (r <= Ri) return 0.06;
    if (r <= Ro) return road(r);
    return e.outer === 'acera' ? road(Ro) + CURB : road(r);
  };
}

export function rbFootprint(e: RoundaboutEntity, H: number, rank: number): Footprint {
  const h = rbHeight(e);
  return circleFootprint(e.id, rank, e.cx, e.cz, e.radius, (r) => H + h(r));
}

export function rbShaper(e: RoundaboutEntity, H: number): RadialShaper {
  const h = rbHeight(e);
  const { Rout } = rbRadii(e);
  return { kind: 'radial', cx: e.cx, cz: e.cz, R: Rout, talud: e.talud, height: (r) => H + h(Math.min(r, Rout)), inset: 0.04 };
}

export function buildRoundabout(e: RoundaboutEntity, H: number, below: Footprint[]): THREE.Group {
  const g = new THREE.Group();
  const { Ro, Ri, Ra, Rout } = rbRadii(e);
  const hf = rbHeight(e);
  const N = Math.max(72, Math.ceil((2 * Math.PI * Rout) / 0.8));
  const inBelow = insideAny(below, 0.2);
  const keepOuter = below.length ? (x: number, z: number) => !inBelow(x, z) : undefined;

  const ring = (buf: GeoBuf, radii: number[], h: (r: number) => number, keep?: (x: number, z: number) => boolean, lift = 0, dash?: [number, number]) => {
    const cols = radii.length;
    const base = buf.count;
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * Math.PI * 2;
      const c = Math.cos(t);
      const s = Math.sin(t);
      for (const r of radii) {
        buf.pos.push(e.cx + r * c, H + h(r) + lift, e.cz + r * s);
        buf.uv.push((r * c) / 4, (r * s) / 4);
      }
    }
    for (let k = 0; k < N; k++) {
      if (dash) {
        const arc = ((k + 0.5) / N) * Math.PI * 2 * radii[0];
        if (arc % (dash[0] + dash[1]) > dash[0]) continue;
      }
      for (let m = 0; m < cols - 1; m++) {
        const a = base + k * cols + m;
        const b = a + 1;
        const c2 = a + cols;
        const d = c2 + 1;
        if (keep) {
          const t = ((k + 0.5) / N) * Math.PI * 2;
          const r = (radii[m] + radii[m + 1]) / 2;
          if (!keep(e.cx + r * Math.cos(t), e.cz + r * Math.sin(t))) continue;
        }
        buf.idx.push(a, c2, b, b, c2, d);
      }
    }
  };
  const wallRing = (buf: GeoBuf, r: number, lo: number, hi: number, outward: boolean, keep?: (x: number, z: number) => boolean) => {
    const base = buf.count;
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * Math.PI * 2;
      const x = e.cx + r * Math.cos(t);
      const z = e.cz + r * Math.sin(t);
      buf.pos.push(x, H + lo, z, x, H + hi, z);
      buf.uv.push(k / 4, 0, k / 4, 1);
    }
    for (let k = 0; k < N; k++) {
      if (keep) {
        const t = ((k + 0.5) / N) * Math.PI * 2;
        if (!keep(e.cx + r * Math.cos(t), e.cz + r * Math.sin(t))) continue;
      }
      const b0 = base + k * 2;
      const t0 = b0 + 1;
      const b1 = b0 + 2;
      const t1 = b0 + 3;
      if (outward) buf.idx.push(b0, t0, b1, b1, t0, t1);
      else buf.idx.push(b0, b1, t0, b1, t1, t0);
    }
  };

  const islandMat = e.island === 'hierba' ? MAT.grass : e.island === 'tierra' ? MAT.earth : MAT.paver;
  const island = new GeoBuf();
  const radiiIsland: number[] = [];
  for (let i = 0; i <= 6; i++) radiiIsland.push((Ra * i) / 6);
  ring(island, radiiIsland, hf);
  const apron = new GeoBuf();
  ring(apron, [Ra, Ri], hf);
  const road = new GeoBuf();
  ring(road, [Ri, (Ri + Ro) / 2, Ro], hf);
  const curb = new GeoBuf();
  wallRing(curb, Ra, hf(Ri), hf(Ra * 0.999), true);
  wallRing(curb, Ri, hf(Ri + 0.001), 0.06, true);

  const outer = new GeoBuf();
  if (e.outer !== 'ninguno') {
    ring(outer, [Ro, Rout], hf, keepOuter);
    if (e.outer === 'acera') wallRing(curb, Ro, hf(Ro * 0.999), hf(Ro + 0.001), false, keepOuter);
  }
  // Marcas: borde interior continuo, borde exterior (interrumpido en las entradas), separación de carriles
  const marks = new GeoBuf();
  const lift = 0.012;
  ring(marks, [Ri + 0.15, Ri + 0.3], hf, undefined, lift);
  ring(marks, [Ro - 0.35, Ro - 0.2], hf, keepOuter, lift);
  const lanes = Math.max(1, Math.round(e.lanes));
  for (let l = 1; l < lanes; l++) {
    const r = Ri + ((Ro - Ri) * l) / lanes;
    ring(marks, [r - 0.06, r + 0.06], hf, undefined, lift, [2, 3]);
  }

  const add = (b: GeoBuf, m: THREE.Material, cast = false) => {
    if (!b.idx.length) return;
    const mesh = b.mesh(m, e.id);
    mesh.receiveShadow = true;
    mesh.castShadow = cast;
    g.add(mesh);
  };
  add(island, islandMat);
  add(apron, MAT.paver);
  add(road, MAT.asphalt.normal);
  add(outer, e.outer === 'acera' ? MAT.sidewalk : MAT.asphalt.normal);
  add(curb, MAT.curb, true);
  add(marks, MAT.marking);
  g.position.y = 0.012;
  return g;
}
