import * as THREE from 'three';
import type { BandType, LineType, RoadEntity } from '../model/types';
import { GeoBuf } from './geobuf';
import { MAT } from './materials';
import { layoutProfile, type ProfileLayout } from './profile';
import type { PathSample } from './spline';
import type { Corridor } from './terrain';
import { insideAny, type Footprint } from './footprint';

const LINE_W = 0.12;
const EDGE_W = 0.15;
const DASH = 3.5;
const GAP = 9;

function bandMaterial(t: BandType, road: RoadEntity): THREE.Material {
  switch (t) {
    case 'carril':
    case 'arcen':
      return MAT.asphalt[road.profile.firme];
    case 'carril_bici':
      return MAT.bike;
    case 'aparcamiento':
      return MAT.parking;
    case 'acera':
      return MAT.sidewalk;
    case 'cuneta':
      return MAT.earth;
    case 'tierra':
      return MAT.gravel;
    case 'hierba':
      return MAT.grass;
  }
}

export function roadCorridor(road: RoadEntity, S: PathSample[], L = layoutProfile(road.profile)): Corridor {
  return {
    samples: S,
    halfL: L.halfL,
    halfR: L.halfR,
    talud: road.profile.talud,
    heightAt: L.heightAt,
    inset: 0.04,
  };
}

export interface RoadBuildContext {
  /** Huellas de rango superior: aquí esta vía se recorta (cruces). */
  above: Footprint[];
  /** Huellas de rango inferior: aquí se interrumpen las líneas de borde. */
  below: Footprint[];
  /** Cota del terreno final (para la berma de transición). */
  terrainH: (x: number, z: number) => number;
}

type Keep = ((x: number, z: number) => boolean) | undefined;

/** Marca vial longitudinal centrada en `o`. */
function marking(g: GeoBuf, S: PathSample[], L: ProfileLayout, o: number, w: number, dashed: boolean, keep: Keep) {
  const h = (x: number) => L.heightAt(x) + 0.012;
  if (!dashed) {
    g.strip(S, [o - w / 2, o + w / 2], h, 4, keep);
    return;
  }
  const period = DASH + GAP;
  let run: PathSample[] = [];
  const flush = () => {
    if (run.length >= 2) g.strip(run, [o - w / 2, o + w / 2], h, 4, keep);
    run = [];
  };
  for (const s of S) {
    if (s.s % period < DASH) run.push(s);
    else flush();
  }
  flush();
}

function lineAt(g: GeoBuf, S: PathSample[], L: ProfileLayout, o: number, type: LineType, w: number, keep: Keep) {
  switch (type) {
    case 'ninguna':
      return;
    case 'continua':
      return marking(g, S, L, o, w, false, keep);
    case 'discontinua':
      return marking(g, S, L, o, w, true, keep);
    case 'doble_continua':
      marking(g, S, L, o - w, w, false, keep);
      return marking(g, S, L, o + w, w, false, keep);
    case 'mixta_a':
      marking(g, S, L, o - w, w, false, keep);
      return marking(g, S, L, o + w, w, true, keep);
    case 'mixta_b':
      marking(g, S, L, o - w, w, true, keep);
      return marking(g, S, L, o + w, w, false, keep);
  }
}

const BERM = 0.9;

export function buildRoad(road: RoadEntity, S: PathSample[], ctx: RoadBuildContext): THREE.Group {
  const group = new THREE.Group();
  group.name = road.name;
  if (S.length < 2) return group;
  const L = layoutProfile(road.profile);
  const inAbove = insideAny(ctx.above);
  const inAboveMarg = insideAny(ctx.above, 0.15);
  const inBelow = insideAny(ctx.below, 0.3);
  const keepSurface: Keep = ctx.above.length ? (x, z) => !inAbove(x, z) : undefined;
  const keepMark: Keep = ctx.above.length ? (x, z) => !inAboveMarg(x, z) : undefined;
  const keepEdge: Keep =
    ctx.above.length || ctx.below.length ? (x, z) => !inAboveMarg(x, z) && !inBelow(x, z) : undefined;

  const buckets = new Map<THREE.Material, GeoBuf>();
  const buf = (m: THREE.Material) => {
    let g = buckets.get(m);
    if (!g) buckets.set(m, (g = new GeoBuf()));
    return g;
  };
  const curb = buf(MAT.curb);
  const marks = new GeoBuf();

  for (let bi = 0; bi < L.bands.length; bi++) {
    const B = L.bands[bi];
    const { band, side, oIn, oOut } = B;
    const offs: number[] = [oIn];
    if (band.type === 'cuneta') offs.push((oIn + oOut) / 2);
    if ((band.type === 'tierra' || band.type === 'hierba') && band.width > 0.4) offs.push(oIn + side * 0.3);
    offs.push(oOut);
    offs.sort((a, b) => a - b);
    buf(bandMaterial(band.type, road)).strip(S, offs, (o) => B.h(o), 4, keepSurface);

    // Escalón con la banda anterior (bordillo de acera, etc.)
    const hIn = B.h(oIn);
    if (Math.abs(hIn - B.prevOut) > 0.005) {
      const lo = Math.min(hIn, B.prevOut);
      const hi = Math.max(hIn, B.prevOut);
      const facesAxis = hIn > B.prevOut;
      const faceRight = side > 0 ? !facesAxis : facesAxis;
      curb.wall(S, oIn, () => lo, () => hi, faceRight, false, 1, keepEdge);
    }

    // Marca en el borde exterior
    if (band.line !== 'ninguna') {
      const next = L.bands[bi + 1];
      const shared = next && next.side === side && next.band.type === 'carril' && band.type === 'carril';
      const w = shared ? LINE_W : EDGE_W;
      const o = shared ? oOut : oOut - side * (w / 2 + 0.05);
      lineAt(marks, S, L, o, band.line, w, shared ? keepMark : keepEdge);
    }
  }
  lineAt(marks, S, L, 0, road.profile.center, LINE_W, keepMark);

  // Berma: franja de transición entre el borde de la vía y el terreno (oculta el escalonado de la malla)
  const berm = buf(MAT.berm);
  for (const side of [-1, 1] as const) {
    const edge = side < 0 ? -L.halfL : L.halfR;
    const outer = edge + side * BERM;
    const offs = side < 0 ? [outer, edge] : [edge, outer];
    berm.strip(
      S,
      offs,
      (o, k) => {
        if (o === edge) return L.heightAt(edge) - 0.005;
        const s = S[k];
        const x = s.x - s.tz * o;
        const z = s.z + s.tx * o;
        return Math.min(ctx.terrainH(x, z) + 0.03, s.y + L.heightAt(edge) + 0.5) - s.y;
      },
      2,
      keepEdge,
    );
  }

  for (const [mat, g] of buckets) {
    if (!g.idx.length) continue;
    const m = g.mesh(mat, road.id);
    m.receiveShadow = true;
    group.add(m);
  }
  if (marks.idx.length) {
    const m = marks.mesh(MAT.marking, road.id);
    m.receiveShadow = true;
    group.add(m);
  }
  // Las vías de mayor rango se elevan unos milímetros para evitar parpadeos en los solapes
  group.position.y = (road.priority ?? 1) * 0.004;
  return group;
}
