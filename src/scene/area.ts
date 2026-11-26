import * as THREE from 'three';
import type { AreaEntity, AreaMaterial, CtrlPoint } from '../model/types';
import { GeoBuf } from './geobuf';
import { MAT } from './materials';
import type { AreaShaper } from './terrain';
import { DEG } from './utils';

export const AREA_LABELS: Record<AreaMaterial, string> = {
  asfalto: 'Asfalto',
  hormigon: 'Hormigón',
  adoquin: 'Adoquín',
  acera: 'Baldosa de acera',
  tierra: 'Tierra',
  grava: 'Grava',
  hierba: 'Hierba / jardín',
  cebreado: 'Cebreado (zona pintada)',
};

function areaMat(m: AreaMaterial): THREE.Material {
  switch (m) {
    case 'asfalto':
      return MAT.asphalt.normal;
    case 'hormigon':
      return MAT.curb;
    case 'adoquin':
      return MAT.paver;
    case 'acera':
      return MAT.sidewalk;
    case 'tierra':
      return MAT.earth;
    case 'grava':
      return MAT.gravel;
    case 'hierba':
      return MAT.grass;
    case 'cebreado':
      return MAT.hatch;
  }
}

export interface AreaGeom {
  ring: [number, number, number][];
  tris: number[][];
}

/** Contorno densificado (cada ~1,5 m) con cotas interpoladas y su triangulación. */
export function areaGeometry(points: CtrlPoint[], heightOf: (p: CtrlPoint) => number): AreaGeom {
  const ring: [number, number, number][] = [];
  if (points.length < 3) return { ring, tris: [] };
  const hs = points.map(heightOf);
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const ha = hs[i];
    const hb = hs[(i + 1) % points.length];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(l / 1.5));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      ring.push([a.x + (b.x - a.x) * t, ha + (hb - ha) * t, a.z + (b.z - a.z) * t]);
    }
  }
  const contour = ring.map(([x, , z]) => new THREE.Vector2(x, z));
  let tris: number[][] = [];
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    tris = [];
  }
  return { ring, tris };
}

export function areaShaper(e: AreaEntity, g: AreaGeom): AreaShaper {
  return { kind: 'area', ring: g.ring, tris: g.tris, talud: e.talud, inset: 0.04 };
}

export function buildArea(e: AreaEntity, g: AreaGeom): THREE.Group {
  const group = new THREE.Group();
  if (g.tris.length === 0) return group;
  const lift = 0.008;
  const top = e.raise + lift;
  const a = e.angle * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const buf = new GeoBuf();
  for (const [x, y, z] of g.ring) {
    buf.pos.push(x, y + top, z);
    buf.uv.push((x * ca + z * sa) / 4, (-x * sa + z * ca) / 4);
  }
  for (const [i, j, k] of g.tris) {
    const [x1, , z1] = g.ring[i];
    const [x2, , z2] = g.ring[j];
    const [x3, , z3] = g.ring[k];
    // normal hacia arriba
    const cross = (x2 - x1) * (z3 - z1) - (z2 - z1) * (x3 - x1);
    if (cross > 0) buf.idx.push(i, k, j);
    else buf.idx.push(i, j, k);
  }
  const mesh = buf.mesh(areaMat(e.material), e.id);
  mesh.receiveShadow = true;
  group.add(mesh);

  if (e.raise > 0.01) {
    // Bordillo perimetral
    const wall = new GeoBuf();
    const R = g.ring;
    let area = 0;
    for (let i = 0; i < R.length; i++) {
      const [xa, , za] = R[i];
      const [xb, , zb] = R[(i + 1) % R.length];
      area += xa * zb - xb * za;
    }
    const ccw = area > 0;
    for (let i = 0; i < R.length; i++) {
      const [xa, ya, za] = R[i];
      const [xb, yb, zb] = R[(i + 1) % R.length];
      const p0 = new THREE.Vector3(xa, ya - 0.03, za);
      const p1 = new THREE.Vector3(xb, yb - 0.03, zb);
      const p2 = new THREE.Vector3(xb, yb + top, zb);
      const p3 = new THREE.Vector3(xa, ya + top, za);
      if (ccw) wall.quad(p1, p0, p3, p2);
      else wall.quad(p0, p1, p2, p3);
    }
    const w = wall.mesh(MAT.curb, e.id);
    w.castShadow = true;
    w.receiveShadow = true;
    group.add(w);
  }
  return group;
}
