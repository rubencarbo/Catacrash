import * as THREE from 'three';
import type { DamageZone, VehicleEntity, VehicleSpec, VehicleType } from '../model/types';
import { colorMat } from './materials';

/**
 * Vehículos generados por código a escala real a partir de su ficha.
 * Sistema local: frontal hacia −Z, derecha hacia +X, suelo en y = 0, origen en el centro de la huella.
 * Las carrocerías se construyen por secciones (loft) para tener vértices en todas las caras
 * y poder deformarlas según los daños.
 */

interface Shape {
  /** Fracciones de la longitud (0 = frontal, 1 = trasera). */
  hood: number;
  roofF: number;
  roofR: number;
  cabEnd: number;
  /** Fracciones de la altura. */
  belt: number;
  nose: number;
  tail: number;
  /** Anchura del habitáculo respecto a la carrocería. */
  cabW: number;
  /** Escotadura en planta de las esquinas (m). */
  corner: number;
  trunk?: number;
}

const SHAPES: Partial<Record<VehicleType, Shape>> = {
  urbano: { hood: 0.25, roofF: 0.43, roofR: 0.82, cabEnd: 0.94, belt: 0.58, nose: 0.47, tail: 0.6, cabW: 0.86, corner: 0.3 },
  compacto: { hood: 0.27, roofF: 0.45, roofR: 0.8, cabEnd: 0.95, belt: 0.56, nose: 0.44, tail: 0.6, cabW: 0.86, corner: 0.32 },
  berlina: { hood: 0.29, roofF: 0.46, roofR: 0.7, cabEnd: 0.83, belt: 0.55, nose: 0.43, tail: 0.58, cabW: 0.85, corner: 0.34, trunk: 0.58 },
  familiar: { hood: 0.28, roofF: 0.44, roofR: 0.93, cabEnd: 0.98, belt: 0.55, nose: 0.43, tail: 0.6, cabW: 0.86, corner: 0.32 },
  coupe: { hood: 0.33, roofF: 0.52, roofR: 0.7, cabEnd: 0.86, belt: 0.56, nose: 0.4, tail: 0.6, cabW: 0.82, corner: 0.36, trunk: 0.6 },
  suv: { hood: 0.26, roofF: 0.42, roofR: 0.88, cabEnd: 0.96, belt: 0.6, nose: 0.5, tail: 0.62, cabW: 0.87, corner: 0.3 },
  suv_grande: { hood: 0.26, roofF: 0.41, roofR: 0.9, cabEnd: 0.97, belt: 0.6, nose: 0.52, tail: 0.63, cabW: 0.87, corner: 0.3 },
  monovolumen: { hood: 0.17, roofF: 0.36, roofR: 0.92, cabEnd: 0.98, belt: 0.53, nose: 0.42, tail: 0.58, cabW: 0.88, corner: 0.3 },
  todoterreno: { hood: 0.27, roofF: 0.38, roofR: 0.95, cabEnd: 0.98, belt: 0.6, nose: 0.55, tail: 0.6, cabW: 0.9, corner: 0.18 },
  pickup: { hood: 0.25, roofF: 0.36, roofR: 0.53, cabEnd: 0.57, belt: 0.6, nose: 0.55, tail: 0.6, cabW: 0.9, corner: 0.18 },
  furgoneta: { hood: 0.16, roofF: 0.3, roofR: 0.98, cabEnd: 1.0, belt: 0.5, nose: 0.42, tail: 0.98, cabW: 0.92, corner: 0.22 },
  furgon: { hood: 0.11, roofF: 0.2, roofR: 0.99, cabEnd: 1.0, belt: 0.44, nose: 0.38, tail: 0.99, cabW: 0.97, corner: 0.18 },
  autobus: { hood: 0.0, roofF: 0.03, roofR: 0.99, cabEnd: 1.0, belt: 0.36, nose: 0.3, tail: 0.99, cabW: 0.98, corner: 0.15 },
};

const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x1d2a33, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.82, clearcoat: 1 });
const tyreMat = colorMat(0x1b1b1b, 0.9);
const rimMat = colorMat(0xb9bec2, 0.35, 0.8);
const darkMat = colorMat(0x222426, 0.7);
const headMat = new THREE.MeshStandardMaterial({ color: 0xf4f6f8, emissive: 0x9aa0a6, emissiveIntensity: 0.2, roughness: 0.2 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0xb3161b, emissive: 0x5a0508, roughness: 0.3 });

const bodyMats = new Map<string, THREE.MeshPhysicalMaterial>();
function bodyMat(color: string) {
  let m = bodyMats.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({ color, roughness: 0.45, metalness: 0.1, clearcoat: 0.35, clearcoatRoughness: 0.3 });
    bodyMats.set(color, m);
  }
  return m;
}

function lerpPoly(pts: [number, number][], x: number) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-6, x1 - x0);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Sólido por secciones. Para cada estación s (desde el frontal) se da la cota inferior, la superior
 * y la semianchura abajo/arriba. Devuelve geometría en coordenadas locales del vehículo.
 */
function loft(
  L: number,
  s0: number,
  s1: number,
  step: number,
  bottom: (s: number) => number,
  top: (s: number) => number,
  halfLow: (s: number) => number,
  halfHigh: (s: number) => number,
  rows = 5,
  across = 6,
): THREE.BufferGeometry {
  const stations: number[] = [];
  const n = Math.max(2, Math.ceil((s1 - s0) / step));
  for (let i = 0; i <= n; i++) stations.push(s0 + ((s1 - s0) * i) / n);
  const ring: [number, number][] = []; // (u lateral −1..1 interpolado entre bajo y alto, v altura 0..1)
  for (let r = 0; r <= rows; r++) ring.push([-1, r / rows]); // lado izquierdo, de abajo arriba
  for (let k = 1; k < across; k++) ring.push([-1 + (2 * k) / across, 1]); // techo
  for (let r = rows; r >= 0; r--) ring.push([1, r / rows]); // lado derecho, de arriba abajo
  for (let k = across - 1; k > 0; k--) ring.push([-1 + (2 * k) / across, 0]); // fondo
  const M = ring.length;
  const pos: number[] = [];
  for (const s of stations) {
    const yb = bottom(s);
    const yt = Math.max(yb + 0.01, top(s));
    const hl = halfLow(s);
    const hh = halfHigh(s);
    for (const [u, v] of ring) {
      const half = hl + (hh - hl) * v;
      // ligera curvatura de los costados
      const bulge = Math.abs(u) === 1 ? Math.sin(v * Math.PI) * 0.02 : 0;
      pos.push(u * (half + bulge), yb + (yt - yb) * v, -L / 2 + s);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < M; j++) {
      const a = i * M + j;
      const b = i * M + ((j + 1) % M);
      const c = (i + 1) * M + j;
      const d = (i + 1) * M + ((j + 1) % M);
      idx.push(a, c, b, b, c, d);
    }
  }
  // tapas delantera y trasera (abanico desde el centro)
  for (const [i, flip] of [
    [0, false],
    [stations.length - 1, true],
  ] as [number, boolean][]) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < M; j++) {
      cx += pos[(i * M + j) * 3];
      cy += pos[(i * M + j) * 3 + 1];
      cz += pos[(i * M + j) * 3 + 2];
    }
    const ci = pos.length / 3;
    pos.push(cx / M, cy / M, cz / M);
    for (let j = 0; j < M; j++) {
      const a = i * M + j;
      const b = i * M + ((j + 1) % M);
      if (flip) idx.push(ci, b, a);
      else idx.push(ci, a, b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Semianchura en planta con esquinas redondeadas. */
function planHalf(W: number, L: number, corner: number, frontSq = 1, rearSq = 1) {
  return (s: number) => {
    const c = Math.max(0.05, corner);
    const df = s / c;
    const dr = (L - s) / c;
    let k = 1;
    if (df < 1) k = Math.min(k, 1 - (1 - Math.sqrt(1 - (1 - df) ** 2)) * 0.55 * frontSq);
    if (dr < 1) k = Math.min(k, 1 - (1 - Math.sqrt(1 - (1 - dr) ** 2)) * 0.5 * rearSq);
    return (W / 2) * k;
  };
}

function mesh(g: THREE.BufferGeometry, m: THREE.Material, deform = true) {
  const o = new THREE.Mesh(g, m);
  o.castShadow = true;
  o.receiveShadow = true;
  o.userData.deform = deform;
  return o;
}

/** Caja orientada entre dos puntos (pilares, tubos), ya colocada en coordenadas locales. */
function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, d: number, m: THREE.Material) {
  const len = a.distanceTo(b);
  const g = new THREE.BoxGeometry(w, len, d);
  const o = new THREE.Mesh(g);
  o.position.copy(a).lerp(b, 0.5);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  o.updateMatrix();
  g.applyMatrix4(o.matrix);
  return mesh(g, m);
}

function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material) {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  const o = new THREE.Mesh(g);
  o.position.copy(a).lerp(b, 0.5);
  o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  o.updateMatrix();
  g.applyMatrix4(o.matrix);
  return mesh(g, m, false);
}

function wheel(r: number, w: number, x: number, z: number, thin = false) {
  const g = new THREE.Group();
  const tyre = new THREE.Mesh(thin ? new THREE.TorusGeometry(r - w / 2, w / 2, 8, 28) : new THREE.CylinderGeometry(r, r, w, 24), tyreMat);
  if (!thin) tyre.rotation.z = Math.PI / 2;
  else tyre.rotation.y = Math.PI / 2;
  tyre.castShadow = true;
  g.add(tyre);
  if (!thin) {
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.01, 18), rimMat);
    rim.rotation.z = Math.PI / 2;
    g.add(rim);
  } else {
    for (let k = 0; k < 8; k++) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, r * 1.9, 4), rimMat);
      sp.rotation.x = (k / 8) * Math.PI;
      g.add(sp);
    }
  }
  g.position.set(x, r, z);
  g.userData.wheel = true;
  return g;
}

const plateCache = new Map<string, THREE.Texture>();
function plateTexture(text: string) {
  let t = plateCache.get(text);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = 520;
  c.height = 110;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f6f6f2';
  g.fillRect(0, 0, 520, 110);
  g.fillStyle = '#1d3f9c';
  g.fillRect(0, 0, 62, 110);
  g.fillStyle = '#ffd400';
  g.font = 'bold 22px Arial';
  g.textAlign = 'center';
  g.fillText('E', 31, 92);
  g.fillStyle = '#111';
  g.font = 'bold 78px Arial';
  g.fillText(text || '0000 XXX', 290, 82);
  g.strokeStyle = '#111';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 516, 106);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  plateCache.set(text, t);
  return t;
}

// ---------------- Turismos, furgonetas y autobuses ----------------

function buildCar(sp: VehicleSpec, color: string, plate: string): THREE.Group {
  const g = new THREE.Group();
  const S = SHAPES[sp.tipo] ?? SHAPES.compacto!;
  const { L, W, H } = sp;
  const r = Math.max(0.2, sp.rueda / 2);
  const clearance = sp.tipo === 'autobus' ? 0.3 : sp.tipo === 'todoterreno' || sp.tipo === 'pickup' ? Math.max(0.2, H * 0.12) : Math.max(0.12, H * 0.1);
  const belt = H * S.belt;
  const axF = sp.volD;
  const axR = L - sp.volT;
  const arch = (s: number) => {
    let y = clearance;
    for (const ax of [axF, axR]) {
      const d = Math.abs(s - ax);
      const R = r * 1.12;
      if (d < R) y = Math.max(y, r + Math.sqrt(R * R - d * d) - 0.02);
    }
    return y;
  };
  const trunkStart = S.trunk ? S.cabEnd * L : L;
  const hullTop: [number, number][] = [
    [0, H * S.nose],
    [Math.min(0.06 * L, 0.3), belt - 0.03],
    [S.hood * L, belt],
    [Math.max(S.hood * L + 0.01, S.cabEnd * L - 0.01), belt + 0.02],
    [trunkStart, (S.trunk ?? S.tail) * H],
    [L - Math.min(0.04 * L, 0.2), S.tail * H],
    [L, S.tail * H - 0.06],
  ];
  hullTop.sort((a, b) => a[0] - b[0]);
  const half = planHalf(W, L, S.corner);
  const hull = loft(
    L,
    0,
    L,
    0.1,
    (s) => (s < 0.15 || s > L - 0.15 ? clearance + 0.08 : arch(s)),
    (s) => lerpPoly(hullTop, s),
    (s) => half(s) * 0.97,
    (s) => half(s),
    5,
    6,
  );
  const bm = bodyMat(color);
  g.add(mesh(hull, bm));

  // Habitáculo acristalado
  const cabW = (W / 2) * S.cabW;
  const cabTop: [number, number][] = [
    [S.hood * L, belt],
    [S.roofF * L, H],
    [S.roofR * L, H],
    [S.cabEnd * L, belt + 0.02],
  ];
  const s0 = S.hood * L;
  const s1 = S.cabEnd * L;
  if (s1 - s0 > 0.2) {
    const cab = loft(
      L,
      s0 + 0.01,
      s1 - 0.01,
      0.1,
      () => belt - 0.01,
      (s) => lerpPoly(cabTop, s),
      (s) => Math.min(half(s) * 0.98, cabW + 0.04),
      (s) => Math.min(half(s), cabW) * 0.86,
      4,
      5,
    );
    g.add(mesh(cab, glassMat));
    // Techo y pilares del color de la carrocería
    const roof = loft(
      L,
      S.roofF * L - 0.05,
      S.roofR * L + 0.05,
      0.1,
      () => H - 0.035,
      () => H + 0.012,
      () => cabW * 0.87,
      () => cabW * 0.82,
      1,
      4,
    );
    g.add(mesh(roof, bm));
    const pw = 0.07;
    for (const sx of [-1, 1]) {
      const at = (s: number, y: number, k: number) => new THREE.Vector3(sx * (k + 0.005), y, -L / 2 + s);
      g.add(beam(at(s0 + 0.03, belt, cabW), at(S.roofF * L, H - 0.02, cabW * 0.86), pw, pw, bm));
      g.add(beam(at(s1 - 0.03, belt, cabW), at(S.roofR * L, H - 0.02, cabW * 0.86), pw * 1.6, pw, bm));
      // pilares intermedios (B, y más en furgonetas/autobuses)
      const span = S.roofR * L - S.roofF * L;
      const nB = sp.tipo === 'autobus' ? Math.floor(span / 1.3) : span > 2.4 ? 2 : 1;
      for (let k = 1; k <= nB; k++) {
        const s = S.roofF * L + (span * k) / (nB + 1);
        g.add(beam(at(s, belt, cabW), at(s, H - 0.02, cabW * 0.86), pw * 1.2, pw, bm));
      }
    }
  }

  // Ruedas
  const tw = Math.min(0.33, Math.max(0.16, W * 0.11));
  for (const [s, via] of [
    [axF, sp.viaD],
    [axR, sp.viaT],
  ]) {
    for (const sx of [-1, 1]) {
      const w = wheel(r, tw, sx * Math.min(via / 2, W / 2 - tw / 2 - 0.01), -L / 2 + s);
      w.userData.side = sx;
      w.userData.axle = s === axF ? 'front' : 'rear';
      g.add(w);
    }
  }
  if (sp.tipo === 'autobus' || sp.tipo === 'furgon') {
    // pasos de rueda oscuros
    for (const s of [axF, axR]) {
      for (const sx of [-1, 1]) {
        const a = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.1, r * 1.1, 0.02, 20, 1, false, Math.PI / 2, Math.PI), darkMat);
        a.rotation.z = Math.PI / 2;
        a.position.set(sx * (half(s) + 0.004), r, -L / 2 + s);
        g.add(a);
      }
    }
  }

  // Faros, pilotos, matrículas y retrovisores
  const fy = H * S.nose - 0.12;
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(Math.min(0.35, W * 0.17), 0.09, 0.05), headMat);
    hl.position.set(sx * (half(0.05) - 0.22), fy, -L / 2 + 0.03);
    hl.userData.deformRigid = true;
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(Math.min(0.3, W * 0.14), 0.1, 0.05), tailMat);
    tl.position.set(sx * (half(L - 0.05) - 0.2), S.tail * H - 0.2, L / 2 - 0.03);
    tl.userData.deformRigid = true;
    g.add(tl);
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.11, 0.07), bm);
    mir.position.set(sx * (W / 2 + 0.06), belt + 0.08, -L / 2 + s0 + 0.15);
    mir.userData.deformRigid = true;
    g.add(mir);
  }
  const pm = new THREE.MeshStandardMaterial({ map: plateTexture(plate), roughness: 0.4 });
  for (const [z, ry, y] of [
    [-L / 2 - 0.012, Math.PI, clearance + 0.25],
    [L / 2 + 0.012, 0, S.tail * H - 0.42],
  ]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.11), pm);
    p.position.set(0, Math.max(clearance + 0.15, y), z);
    p.rotation.y = ry;
    p.userData.deformRigid = true;
    g.add(p);
  }
  return g;
}

// ---------------- Camiones ----------------

function buildTruck(sp: VehicleSpec, color: string, plate: string): THREE.Group {
  const g = new THREE.Group();
  const { L, W, H } = sp;
  const r = Math.max(0.35, sp.rueda / 2);
  const cabL = Math.min(2.3, L * 0.32);
  const cabH = sp.tipo === 'tractora' ? H : Math.min(H, 3.1);
  const frameY = r * 1.9;
  const bm = bodyMat(color);
  const half = planHalf(W, cabL, 0.15);
  const cab = loft(L, 0, cabL, 0.1, () => r * 1.1, (s) => cabH - (s < 0.3 ? (0.3 - s) * 0.5 : 0), (s) => half(s), (s) => half(s) * 0.95, 6, 6);
  g.add(mesh(cab, bm));
  // parabrisas
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.86, cabH * 0.3), glassMat);
  ws.position.set(0, cabH * 0.72, -L / 2 - 0.01);
  ws.rotation.y = Math.PI;
  g.add(ws);
  // bastidor
  const frame = new THREE.Mesh(new THREE.BoxGeometry(W * 0.4, 0.25, L - cabL * 0.5), darkMat);
  frame.position.set(0, frameY - 0.2, cabL * 0.25);
  frame.castShadow = true;
  g.add(frame);
  if (sp.tipo === 'camion') {
    const box = loft(L, cabL + 0.15, L, 0.25, () => frameY, () => H, () => W / 2, () => W / 2, 6, 6);
    g.add(mesh(box, colorMat(0xe8e8e4, 0.6)));
  } else {
    const plate5 = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.1, 20), darkMat);
    plate5.position.set(0, frameY + 0.05, L / 2 - sp.volT - 0.3);
    g.add(plate5);
  }
  const tw = 0.32;
  for (const [s, via, dual] of [
    [sp.volD, sp.viaD, false],
    [L - sp.volT, sp.viaT, true],
  ] as [number, number, boolean][]) {
    for (const sx of [-1, 1]) {
      g.add(wheel(r, tw, sx * Math.min(via / 2, W / 2 - tw / 2), -L / 2 + s));
      if (dual) g.add(wheel(r, tw, sx * Math.min(via / 2 - tw - 0.02, W / 2 - tw * 1.5), -L / 2 + s));
    }
  }
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.05), headMat);
    hl.position.set(sx * (W / 2 - 0.3), r * 1.5, -L / 2 - 0.01);
    g.add(hl);
  }
  const pm = new THREE.MeshStandardMaterial({ map: plateTexture(plate) });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.11), pm);
  p.position.set(0, r * 1.2, -L / 2 - 0.015);
  p.rotation.y = Math.PI;
  g.add(p);
  return g;
}

// ---------------- Dos ruedas, patinetes y peatones ----------------

function rider(H: number, clothes: string, seatY: number, z: number, lean: number) {
  const g = new THREE.Group();
  const m = colorMat(clothes, 0.8);
  const skin = colorMat(0xc89b7b, 0.7);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.45, 4, 8), m);
  torso.position.set(0, seatY + 0.35, z);
  torso.rotation.x = -lean;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), colorMat(0x222222, 0.4));
  head.position.set(0, seatY + 0.8, z - 0.25 * Math.sin(lean) - 0.05);
  const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.5, 4, 6), colorMat(0x2b3245, 0.8));
  legs.position.set(0, seatY - 0.05, z - 0.25);
  legs.rotation.x = Math.PI / 2.4;
  g.add(torso, head, legs);
  void skin;
  void H;
  g.traverse((o) => (o.castShadow = true));
  return g;
}

function buildTwoWheeler(sp: VehicleSpec, color: string, occupants: number): THREE.Group {
  const g = new THREE.Group();
  const { L, H } = sp;
  const r = Math.max(0.1, sp.rueda / 2);
  const zF = -L / 2 + sp.volD;
  const zR = -L / 2 + sp.volD + sp.batalla;
  const thin = sp.tipo === 'bicicleta';
  const tw = sp.tipo === 'moto' ? 0.16 : sp.tipo === 'ciclomotor' ? 0.12 : sp.tipo === 'patinete' ? 0.06 : 0.035;
  g.add(wheel(r, tw, 0, zF, thin), wheel(r, tw, 0, zR, thin));
  const bm = bodyMat(color);
  const metal = colorMat(0x8a8f93, 0.4, 0.7);
  const V = (y: number, z: number, x = 0) => new THREE.Vector3(x, y, z);
  if (sp.tipo === 'bicicleta') {
    const bb = V(r * 0.95, zR - sp.batalla * 0.42);
    const seat = V(H * 0.78, zR - sp.batalla * 0.32);
    const head = V(H * 0.82, zF + 0.18);
    for (const [a, b] of [
      [V(r, zR), bb],
      [bb, seat],
      [seat, V(r, zR)],
      [bb, head],
      [seat, head],
      [head, V(r, zF)],
    ])
      g.add(tube(a, b, 0.018, bm));
    g.add(tube(V(H * 0.92, zF + 0.12, -0.28), V(H * 0.92, zF + 0.12, 0.28), 0.014, metal));
    if (occupants > 0) g.add(rider(1.75, '#3d6e9e', seat.y, seat.z, 0.5));
  } else if (sp.tipo === 'patinete') {
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.05, sp.batalla * 0.8), darkMat);
    deck.position.set(0, r + 0.02, (zF + zR) / 2);
    g.add(deck, tube(V(r, zF), V(H, zF + 0.05), 0.02, bm), tube(V(H, zF + 0.05, -0.25), V(H, zF + 0.05, 0.25), 0.015, metal));
    if (occupants > 0) g.add(rider(1.75, '#555b66', r + 0.9, (zF + zR) / 2, 0.1));
  } else {
    // moto / ciclomotor
    const tank = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, sp.batalla * 0.35, 4, 10), bm);
    tank.rotation.x = Math.PI / 2;
    tank.position.set(0, H * 0.72, (zF + zR) / 2 - 0.1);
    const engine = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, sp.batalla * 0.35), metal);
    engine.position.set(0, r + 0.12, (zF + zR) / 2);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, sp.batalla * 0.4), darkMat);
    seat.position.set(0, H * 0.7, zR - sp.batalla * 0.3);
    g.add(tank, engine, seat, tube(V(r, zF), V(H * 0.92, zF + 0.2), 0.03, metal), tube(V(H * 0.95, zF + 0.22, -0.36), V(H * 0.95, zF + 0.22, 0.36), 0.018, metal));
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), headMat);
    hl.position.set(0, H * 0.82, zF + 0.12);
    g.add(hl);
    if (occupants > 0) g.add(rider(1.75, '#2f2f33', H * 0.72, zR - sp.batalla * 0.3, 0.35));
  }
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return g;
}

function buildPedestrian(sp: VehicleSpec, color: string): THREE.Group {
  const g = new THREE.Group();
  const H = sp.H;
  const k = H / 1.75;
  const clothes = colorMat(color, 0.85);
  const legsM = colorMat(0x2b3245, 0.85);
  const skin = colorMat(0xc89b7b, 0.7);
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.075 * k, 0.72 * k, 4, 8), legsM);
    leg.position.set(sx * 0.1 * k, 0.45 * k, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.05 * k, 0.55 * k, 4, 8), clothes);
    arm.position.set(sx * 0.26 * k, 1.1 * k, 0);
    g.add(leg, arm);
  }
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.17 * k, 0.45 * k, 4, 10), clothes);
  torso.position.y = 1.15 * k;
  torso.scale.z = 0.7;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11 * k, 16, 12), skin);
  head.position.y = 1.62 * k;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.115 * k, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), colorMat(0x2a1d14, 0.9));
  hair.position.y = 1.63 * k;
  g.add(torso, head, hair);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return g;
}

// ---------------- Daños ----------------

const smooth = (t: number) => {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
};
/** Peso 1 dentro de [a, b] con transición suave de anchura `soft`. */
const band = (v: number, a: number, b: number, soft: number) => smooth((v - a + soft) / soft) * smooth((b - v + soft) / soft);

/**
 * Deforma la geometría del vehículo según las zonas dañadas: los puntos más cercanos al lado
 * dañado se desplazan hacia dentro la profundidad indicada, con una transición progresiva
 * (zona de aplastamiento) y un leve arrugado.
 */
export function applyDamage(group: THREE.Group, sp: VehicleSpec, zones: DamageZone[]) {
  if (!zones.length) return;
  const { L, W, H } = sp;
  const v = new THREE.Vector3();
  const disp = (p: THREE.Vector3) => {
    const s = p.z + L / 2; // desde el frontal
    const out = p.clone();
    for (const z of zones) {
      const D = Math.max(0, z.depth);
      if (D <= 0) continue;
      const fh = band(p.y / H, z.hFrom, z.hTo, 0.12);
      if (fh <= 0) continue;
      const reach = D + 0.5;
      const crumple = 1 + 0.12 * Math.sin(p.x * 23 + p.y * 17 + p.z * 11);
      if (z.side === 'frontal' || z.side === 'trasera') {
        const u = (p.x + W / 2) / W; // 0 = izquierda, 1 = derecha
        const fu = band(u, z.from, z.to, 0.12);
        const d = z.side === 'frontal' ? s : L - s;
        if (d >= reach || fu <= 0) continue;
        const push = D * (1 - d / reach) * fu * fh * crumple;
        out.z += z.side === 'frontal' ? push : -push;
        out.y -= push * 0.08 * Math.sin(p.x * 9);
      } else if (z.side === 'izquierda' || z.side === 'derecha') {
        const u = s / L; // 0 = frontal, 1 = trasera
        const fu = band(u, z.from, z.to, 0.06);
        const sx = z.side === 'izquierda' ? -1 : 1;
        const d = W / 2 - sx * p.x;
        if (d >= reach || fu <= 0) continue;
        const push = D * (1 - d / reach) * fu * fh * crumple;
        out.x -= sx * push;
      } else {
        const u = s / L;
        const fu = band(u, z.from, z.to, 0.06);
        const d = H - p.y;
        if (d >= reach || fu <= 0) continue;
        out.y -= D * (1 - d / reach) * fu * crumple;
      }
    }
    return out;
  };
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (m.userData.deform) {
      const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const d = disp(v);
        pos.setXYZ(i, d.x, d.y, d.z);
      }
      pos.needsUpdate = true;
      m.geometry.computeVertexNormals();
    } else if (m.userData.deformRigid) {
      const d = disp(m.position);
      m.position.copy(d);
    }
  });
  // Ruedas: retroceso y giro si el aplastamiento alcanza el eje
  group.children.forEach((c) => {
    if (!c.userData.wheel) return;
    const before = c.position.clone();
    const after = disp(new THREE.Vector3(before.x, before.y + 0.1, before.z));
    const dz = after.z - before.z;
    const dx = after.x - before.x;
    if (Math.abs(dz) > 0.03 || Math.abs(dx) > 0.03) {
      c.position.z += dz * 0.8;
      c.position.x += dx * 0.8;
      c.rotation.y = Math.max(-0.5, Math.min(0.5, (dz + dx) * 1.5));
    }
  });
}

/** Construye el vehículo completo (sin colocar en la escena). */
export function buildVehicle(e: VehicleEntity): THREE.Group {
  const sp = e.spec;
  let body: THREE.Group;
  if (sp.tipo === 'peaton') body = buildPedestrian(sp, e.color);
  else if (sp.tipo === 'moto' || sp.tipo === 'ciclomotor' || sp.tipo === 'bicicleta' || sp.tipo === 'patinete') body = buildTwoWheeler(sp, e.color, e.occupants);
  else if (sp.tipo === 'camion' || sp.tipo === 'tractora') body = buildTruck(sp, e.color, e.plate);
  else body = buildCar(sp, e.color, e.plate);
  applyDamage(body, sp, e.damage);
  body.traverse((o) => (o.userData.entityId = e.id));
  return body;
}
