import * as THREE from 'three';
import type { LinearEntity } from '../model/types';
import { extrude, GeoBuf } from './geobuf';
import { colorMat } from './materials';
import { PATTERN } from './patterns';
import { samplePath, type PathSample } from './spline';
import type { Terrain } from './terrain';

const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function patternMat(key: keyof typeof PATTERN, opts: THREE.MeshStandardMaterialParameters = {}) {
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ map: PATTERN[key], roughness: 0.9, ...opts });
    matCache.set(key, m);
  }
  return m;
}

function shadowed<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return o;
}

/** Muestras sobre el terreno final (los elementos lineales se apoyan en él). */
export function linearSamples(e: LinearEntity, terrain: Terrain, step = 0.5): PathSample[] {
  const smooth = e.type !== 'tendido' && e.params.curva === true;
  const S = samplePath(e.points, (p) => terrain.height(p.x, p.z), step, smooth);
  for (const s of S) s.y = terrain.height(s.x, s.z);
  return S;
}

/** Puntos a intervalos regulares a lo largo del trazado (postes). */
function every(S: PathSample[], spacing: number): PathSample[] {
  const out: PathSample[] = [];
  if (!S.length) return out;
  const total = S[S.length - 1].s;
  const n = Math.max(1, Math.round(total / spacing));
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (k < S.length - 2 && S[k + 1].s < target) k++;
    const a = S[k];
    const b = S[Math.min(S.length - 1, k + 1)];
    const t = b.s > a.s ? (target - a.s) / (b.s - a.s) : 0;
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
      s: target,
      tx: a.tx,
      tz: a.tz,
    });
  }
  return out;
}

function posts(S: PathSample[], spacing: number, geo: THREE.BufferGeometry, mat: THREE.Material, yOff = 0) {
  const pts = every(S, spacing);
  const inst = new THREE.InstancedMesh(geo, mat, pts.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  pts.forEach((p, i) => {
    q.setFromAxisAngle(up, Math.atan2(p.tx, p.tz));
    m.compose(new THREE.Vector3(p.x, p.y + yOff, p.z), q, new THREE.Vector3(1, 1, 1));
    inst.setMatrixAt(i, m);
  });
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

export function buildLinear(e: LinearEntity, terrain: Terrain): THREE.Group {
  const g = new THREE.Group();
  g.name = e.name;
  const P = e.params;
  const S = linearSamples(e, terrain);
  if (S.length < 2) return g;
  const ground = (k: number) => S[k].y;

  switch (e.type) {
    case 'muro': {
      const h = num(P.altura, 1.5);
      const w = num(P.grosor, 0.4) / 2;
      const prof: [number, number][] = [
        [w, -0.4],
        [w, h],
        [-w, h],
        [-w, -0.4],
      ];
      const key = str(P.material, 'hormigon') as keyof typeof PATTERN;
      const mat = patternMat(PATTERN[key] ? key : 'hormigon');
      g.add(new THREE.Mesh(extrude(S, prof, ground, false, 1), mat));
      // tapas
      const caps = new GeoBuf();
      for (const [s, dir] of [
        [S[0], -1],
        [S[S.length - 1], 1],
      ] as const) {
        const nx = -s.tz;
        const nz = s.tx;
        const P0 = (o: number, y: number) => new THREE.Vector3(s.x + nx * o, s.y + y, s.z + nz * o);
        if (dir < 0) caps.quad(P0(-w, -0.4), P0(w, -0.4), P0(w, h), P0(-w, h));
        else caps.quad(P0(w, -0.4), P0(-w, -0.4), P0(-w, h), P0(w, h));
      }
      g.add(new THREE.Mesh(caps.build(), mat));
      break;
    }
    case 'bordillo': {
      const h = num(P.altura, 0.15);
      const w = num(P.ancho, 0.15) / 2;
      g.add(new THREE.Mesh(extrude(S, [[w, -0.1], [w, h], [-w, h], [-w, -0.1]], ground), colorMat(0xc9c6bf, 0.85)));
      break;
    }
    case 'seto': {
      const h = num(P.altura, 1.2);
      const w = num(P.ancho, 0.8) / 2;
      const prof: [number, number][] = [
        [w * 0.8, -0.1],
        [w, h * 0.4],
        [w * 0.9, h * 0.85],
        [w * 0.5, h],
        [-w * 0.5, h],
        [-w * 0.9, h * 0.85],
        [-w, h * 0.4],
        [-w * 0.8, -0.1],
      ];
      g.add(new THREE.Mesh(extrude(S, prof, ground, false, 1.5), patternMat('hojas', { roughness: 1 })));
      break;
    }
    case 'barrera_hormigon': {
      const prof: [number, number][] = [
        [0.3, -0.05],
        [0.3, 0.08],
        [0.2, 0.33],
        [0.08, 0.81],
        [-0.08, 0.81],
        [-0.2, 0.33],
        [-0.3, 0.08],
        [-0.3, -0.05],
      ];
      g.add(new THREE.Mesh(extrude(S, prof, ground, false, 1), patternMat('hormigon')));
      break;
    }
    case 'guardarrail': {
      const h = num(P.altura, 0.75);
      const side = P.lado === 'derecha' ? 1 : -1;
      const postGeo = new THREE.BoxGeometry(0.1, h + 0.1, 0.06).translate(0, (h + 0.1) / 2 - 0.1, 0);
      g.add(posts(S, num(P.separacion, 4), postGeo, colorMat(0x8f979c, 0.45, 0.7)));
      // Perfil en W (bionda) desplazado hacia el lado de la calzada
      const c = h - 0.17;
      const o = side * 0.12;
      const prof: [number, number][] = [
        [o, c - 0.155],
        [o + side * 0.05, c - 0.08],
        [o, c],
        [o + side * 0.05, c + 0.08],
        [o, c + 0.155],
      ];
      const mat = colorMat(0xb9c0c4, 0.35, 0.8, 'double');
      g.add(new THREE.Mesh(extrude(S, prof, ground, false, 1), mat));
      break;
    }
    case 'valla': {
      const h = num(P.altura, 1.5);
      const tipo = str(P.tipo, 'malla');
      const spacing = num(P.separacion, 2.5);
      const postMat = tipo === 'madera' ? colorMat(0x7a5a3a, 0.9) : colorMat(0x5d6466, 0.5, 0.6);
      const postGeo =
        tipo === 'madera'
          ? new THREE.BoxGeometry(0.1, h + 0.3, 0.1).translate(0, (h + 0.3) / 2 - 0.3, 0)
          : new THREE.CylinderGeometry(0.03, 0.03, h + 0.3, 8).translate(0, (h + 0.3) / 2 - 0.3, 0);
      g.add(posts(S, spacing, postGeo, postMat));
      const key = tipo === 'madera' ? 'madera' : tipo === 'metalica' ? 'barrotes' : 'malla';
      const tex = PATTERN[key].clone();
      tex.repeat.set(1, 1 / h);
      tex.needsUpdate = true;
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        alphaTest: 0.4,
        transparent: false,
        side: THREE.DoubleSide,
        roughness: 0.7,
        metalness: tipo === 'madera' ? 0 : 0.4,
      });
      const buf = new GeoBuf();
      buf.wall(S, 0, (k) => S[k].y + 0.03, (k) => S[k].y + h, true, true, 1);
      // uv: u = distancia, v = altura absoluta → normalizar v a la altura de la valla
      const uv = buf.uv;
      for (let k = 0; k < S.length; k++) {
        uv[k * 4 + 1] = 0;
        uv[k * 4 + 3] = h;
      }
      const mesh = new THREE.Mesh(buf.build(), mat);
      g.add(mesh);
      break;
    }
    case 'tendido': {
      buildPowerLine(g, e, S, terrain);
      break;
    }
  }
  g.traverse((o) => (o.userData.entityId = e.id));
  return shadowed(g);
}

function buildPowerLine(g: THREE.Group, e: LinearEntity, S: PathSample[], terrain: Terrain) {
  const P = e.params;
  const H = num(P.altura, 9);
  const nc = Math.max(1, Math.min(6, Math.round(num(P.cables, 3))));
  const sag = num(P.flecha, 0.8);
  const sep = num(P.separacion, 0.6);
  const tipo = str(P.poste, 'madera');
  const poleMat =
    tipo === 'madera' ? colorMat(0x5b4430, 0.95) : tipo === 'metalico' ? colorMat(0x7d868a, 0.45, 0.7) : colorMat(0xb4b0a6, 0.85);
  const poleGeo =
    tipo === 'hormigon'
      ? new THREE.BoxGeometry(0.28, H, 0.18).translate(0, H / 2, 0)
      : new THREE.CylinderGeometry(tipo === 'madera' ? 0.11 : 0.09, tipo === 'madera' ? 0.14 : 0.12, H, 10).translate(0, H / 2, 0);
  const armLen = sep * (nc - 1) + 0.4;
  const armGeo = new THREE.BoxGeometry(armLen, 0.1, 0.1);
  const insGeo = new THREE.CylinderGeometry(0.04, 0.05, 0.18, 8);
  const insMat = colorMat(tipo === 'madera' ? 0x6a8f6c : 0xd9d6cc, 0.4);
  const cableMat = colorMat(0x1d1f20, 0.6, 0.3);

  // Postes en los puntos de control
  const tops: THREE.Vector3[][] = [];
  const pts = e.points;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const y = terrain.height(p.x, p.z);
    // dirección media del tendido en el poste
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const ang = Math.atan2(b.x - a.x, b.z - a.z);
    const pole = new THREE.Group();
    pole.position.set(p.x, y - 0.6, p.z);
    pole.rotation.y = ang;
    pole.add(new THREE.Mesh(poleGeo, poleMat));
    const arm = new THREE.Mesh(armGeo, poleMat);
    arm.position.y = H - 0.35;
    pole.add(arm);
    const local: THREE.Vector3[] = [];
    for (let c = 0; c < nc; c++) {
      const lx = (c - (nc - 1) / 2) * sep;
      const ins = new THREE.Mesh(insGeo, insMat);
      ins.position.set(lx, H - 0.2, 0);
      pole.add(ins);
      local.push(new THREE.Vector3(lx, H - 0.1, 0));
    }
    g.add(pole);
    pole.updateMatrixWorld(true);
    tops.push(local.map((v) => v.clone().applyMatrix4(pole.matrixWorld)));
  }
  // Cables con catenaria aproximada (parábola)
  for (let i = 0; i < tops.length - 1; i++) {
    for (let c = 0; c < nc; c++) {
      const A = tops[i][c];
      const B = tops[i + 1][c];
      const span = A.distanceTo(B);
      const f = sag * Math.min(2, span / 40);
      const curvePts: THREE.Vector3[] = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        const p = A.clone().lerp(B, t);
        p.y -= 4 * f * t * (1 - t);
        curvePts.push(p);
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(curvePts), 24, 0.018, 4, false);
      g.add(new THREE.Mesh(tube, cableMat));
    }
  }
  void S;
}
