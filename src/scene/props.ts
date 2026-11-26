import * as THREE from 'three';
import { bool, color, num, sel, text, type FieldDef } from '../model/fields';
import type { Params } from '../model/types';
import { colorMat, MAT } from './materials';
import { SIGNS, signTextures, textTexture } from './signs';
import { rng } from './utils';

/**
 * Catálogo de objetos puntuales. Todos se construyen por código a escala real (metros),
 * de modo que cualquier dimensión es editable sin modelos externos.
 * Convención: el frente del objeto mira hacia +Z local.
 */
export interface PropDef {
  label: string;
  category: string;
  fields: FieldDef[];
  defaults: Params;
  build: (P: Params, seed: number) => THREE.Object3D;
  /** Se apoya sobre la calzada (marcas viales) en lugar del terreno. */
  onSurface?: boolean;
}

const n = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
const s = (v: unknown, d: string) => (typeof v === 'string' ? v : d);

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Esfera deformada de forma estable (copas, arbustos, rocas). */
function blob(r: number, seed: number, rough = 0.18, detail = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const a = (seed % 997) * 0.013;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + rough * (Math.sin(x * 3.1 / r + a) * Math.cos(z * 2.7 / r + a * 2) + Math.sin(y * 4.3 / r + a * 3) * 0.6);
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

// ---------------- Árboles ----------------

const LEAF: Record<string, number> = {
  verde: 0x56732f,
  oscuro: 0x2f4a22,
  claro: 0x7c9640,
  otono: 0xb8722a,
  seco: 0x9a8f4c,
};

function tree(P: Params, seed: number): THREE.Object3D {
  const g = new THREE.Group();
  const r = rng(seed);
  const sp = s(P.especie, 'frondoso');
  const H = n(P.altura, 8);
  const D = n(P.tronco, 0.35);
  const C = n(P.copa, 5);
  const hoja = s(P.hoja, 'verde');
  const bare = hoja === 'sin_hoja';
  let leafColor = LEAF[hoja] ?? LEAF.verde;
  if (sp === 'olivo' && hoja === 'verde') leafColor = 0x7f8c5f;
  if ((sp === 'cipres' || sp === 'conifera') && hoja === 'verde') leafColor = 0x2d4626;
  if (sp === 'pino' || sp === 'pinonero') leafColor = hoja === 'verde' ? 0x3f5b2c : leafColor;
  const leaf = colorMat(leafColor, 0.95, 0, 'flat');
  const bark = colorMat(sp === 'olivo' ? 0x6b6455 : sp === 'palmera' ? 0x8a7660 : 0x5a4634, 1);

  const trunk = (h: number, d0: number, d1 = d0 * 0.6, lean = 0) => {
    const t = mesh(new THREE.CylinderGeometry(d1 / 2, d0 / 2, h, 9).translate(0, h / 2, 0), bark);
    t.rotation.z = lean;
    g.add(t);
    return t;
  };
  const crownBlobs = (cy: number, rx: number, ry: number, count: number, size: number) => {
    for (let i = 0; i < count; i++) {
      const a = r() * Math.PI * 2;
      const rr = Math.sqrt(r());
      const b = mesh(blob(size * (0.75 + r() * 0.4), seed + i), leaf);
      b.position.set(Math.cos(a) * rx * rr, cy + (r() - 0.4) * ry, Math.sin(a) * rx * rr);
      b.scale.y = 0.85;
      g.add(b);
    }
  };
  const branches = (y0: number, len: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const br = mesh(new THREE.CylinderGeometry(D * 0.08, D * 0.22, len, 6).translate(0, len / 2, 0), bark, 0, y0, 0);
      br.rotation.set((r() - 0.5) * 1.2, r() * Math.PI * 2, 0.5 + r() * 0.5);
      br.rotation.order = 'YXZ';
      g.add(br);
    }
  };

  switch (sp) {
    case 'arbusto': {
      const k = 3 + Math.floor(r() * 3);
      for (let i = 0; i < k; i++) {
        const b = mesh(blob(C * 0.32, seed + i), leaf);
        b.position.set((r() - 0.5) * C * 0.5, H * 0.45, (r() - 0.5) * C * 0.5);
        b.scale.set(1, H / C, 1);
        g.add(b);
      }
      break;
    }
    case 'cipres': {
      trunk(H * 0.15, D);
      const c = mesh(blob(1, seed, 0.08, 2), leaf);
      c.scale.set(C / 2, H * 0.47, C / 2);
      c.position.y = H * 0.52;
      g.add(c);
      break;
    }
    case 'conifera': {
      trunk(H * 0.35, D);
      const levels = 5;
      for (let i = 0; i < levels; i++) {
        const t = i / levels;
        const rad = (C / 2) * (1 - t * 0.8);
        const h = (H * 0.75) / levels * 1.7;
        g.add(mesh(new THREE.ConeGeometry(rad, h, 10).translate(0, h / 2, 0), leaf, 0, H * 0.22 + t * H * 0.62, 0));
      }
      break;
    }
    case 'palmera': {
      const segs = 7;
      let y = 0;
      let x = 0;
      const bend = (r() - 0.5) * 0.12;
      for (let i = 0; i < segs; i++) {
        const h = (H * 0.92) / segs;
        const t = mesh(new THREE.CylinderGeometry(D * 0.42, D * 0.5, h * 1.05, 9).translate(0, h / 2, 0), bark, x, y, 0);
        t.rotation.z = -bend * i;
        g.add(t);
        y += h * Math.cos(bend * i);
        x += h * Math.sin(bend * i);
      }
      const fronds = 12;
      for (let i = 0; i < fronds; i++) {
        const len = C * 0.55;
        const geo = new THREE.PlaneGeometry(len, len * 0.22, 8, 1);
        const p = geo.getAttribute('position') as THREE.BufferAttribute;
        const droop = 0.5 + r() * 0.3;
        for (let k = 0; k < p.count; k++) {
          const px = p.getX(k) + len / 2; // 0..len a lo largo de la hoja
          const w = Math.sin((px / len) * Math.PI) * 0.9 + 0.1;
          const across = p.getY(k) * w;
          p.setXYZ(k, px, px * 0.3 - (px / len) ** 2 * len * droop, across);
        }
        geo.computeVertexNormals();
        const f = new THREE.Mesh(geo, colorMat(leafColor, 0.9, 0, 'double'));
        f.castShadow = true;
        const holder = new THREE.Group();
        holder.position.set(x, y, 0);
        holder.rotation.y = (i / fronds) * Math.PI * 2 + r() * 0.3;
        holder.add(f);
        g.add(holder);
      }
      break;
    }
    case 'olivo': {
      const t1 = trunk(H * 0.35, D, D * 0.7, 0.12);
      t1.position.x = -0.05;
      trunk(H * 0.32, D * 0.7, D * 0.45, -0.25);
      if (bare) branches(H * 0.3, H * 0.5, 6);
      else crownBlobs(H * 0.62, C * 0.32, H * 0.18, 8, C * 0.26);
      break;
    }
    case 'pinonero': {
      trunk(H * 0.78, D, D * 0.55, (r() - 0.5) * 0.1);
      const top = mesh(blob(C / 2, seed, 0.12, 2), leaf, 0, H * 0.85, 0);
      top.scale.y = 0.32;
      g.add(top);
      crownBlobs(H * 0.82, C * 0.3, H * 0.04, 5, C * 0.2);
      break;
    }
    case 'pino': {
      trunk(H * 0.7, D, D * 0.5, (r() - 0.5) * 0.15);
      crownBlobs(H * 0.78, C * 0.3, H * 0.15, 6, C * 0.24);
      break;
    }
    case 'chopo': {
      trunk(H * 0.3, D, D * 0.6);
      if (bare) branches(H * 0.25, H * 0.6, 8);
      else {
        for (let i = 0; i < 5; i++) {
          const b = mesh(blob(C / 2, seed + i, 0.15), leaf, (r() - 0.5) * 0.4, H * (0.32 + i * 0.13), (r() - 0.5) * 0.4);
          b.scale.y = 1.4;
          g.add(b);
        }
      }
      break;
    }
    default: {
      // frondoso (encina, plátano, roble…)
      trunk(H * 0.5, D, D * 0.65);
      if (bare) branches(H * 0.45, H * 0.45, 7);
      else crownBlobs(H * 0.66, C * 0.3, H * 0.2, 7, C * 0.3);
    }
  }
  return g;
}

// ---------------- Iluminación y señalización ----------------

const metal = () => colorMat(0x6f777b, 0.45, 0.7);
const darkMetal = () => colorMat(0x2b3133, 0.5, 0.5);

function lampMat(on: boolean) {
  const m = new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: on ? 0xffd28a : 0x000000, emissiveIntensity: on ? 2.5 : 0 });
  return m;
}

/** Foco real de una farola encendida (sin sombras para no penalizar el rendimiento). */
function lampLight(g: THREE.Group, x: number, y: number, z: number) {
  const l = new THREE.SpotLight(0xffd9a0, 900, 40, 1.15, 0.65, 2);
  l.position.set(x, y, z);
  l.target.position.set(x, 0, z);
  g.add(l, l.target);
}

function streetlight(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const H = n(P.altura, 8);
  const arm = n(P.brazo, 1.5);
  const style = s(P.estilo, 'vial');
  const on = P.encendida === true;
  if (style === 'clasica') {
    const m = darkMetal();
    g.add(mesh(new THREE.CylinderGeometry(0.05, 0.09, H, 10).translate(0, H / 2, 0), m));
    g.add(mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.6, 10).translate(0, 0.3, 0), m));
    g.add(mesh(new THREE.BoxGeometry(0.32, 0.45, 0.32), lampMat(on), 0, H + 0.22, 0));
    if (on) lampLight(g, 0, H, 0);
    g.add(mesh(new THREE.ConeGeometry(0.3, 0.25, 4).rotateY(Math.PI / 4), m, 0, H + 0.57, 0));
    return g;
  }
  const m = metal();
  g.add(mesh(new THREE.CylinderGeometry(0.055, 0.1, H, 10).translate(0, H / 2, 0), m));
  const arms = P.doble === true ? [1, -1] : [1];
  for (const d of arms) {
    const a = mesh(new THREE.CylinderGeometry(0.035, 0.045, arm, 8).rotateX(Math.PI / 2).translate(0, 0, arm / 2), m, 0, H - 0.1, 0);
    a.rotation.y = d > 0 ? 0 : Math.PI;
    a.rotation.x = -0.1;
    g.add(a);
    const lum = mesh(new THREE.BoxGeometry(0.28, 0.1, 0.62), m, 0, H - 0.05, d * (arm + 0.2));
    g.add(lum);
    g.add(mesh(new THREE.BoxGeometry(0.22, 0.02, 0.5), lampMat(on), 0, H - 0.11, d * (arm + 0.2)));
    if (on) lampLight(g, 0, H - 0.2, d * (arm + 0.2));
  }
  return g;
}

function trafficLight(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const H = n(P.altura, 2.4);
  const estado = s(P.estado, 'rojo');
  g.add(mesh(new THREE.CylinderGeometry(0.05, 0.06, H, 10).translate(0, H / 2, 0), darkMetal()));
  g.add(mesh(new THREE.BoxGeometry(0.3, 0.9, 0.22), colorMat(0x1b1d1e, 0.6), 0, H + 0.45, 0));
  const colors: [string, number][] = [
    ['rojo', 0xff2a1a],
    ['ambar', 0xffa31a],
    ['verde', 0x1aff6a],
  ];
  colors.forEach(([k, c], i) => {
    const on = estado === k;
    const mat = new THREE.MeshStandardMaterial({ color: on ? c : 0x2a2a2a, emissive: on ? c : 0, emissiveIntensity: on ? 3 : 0 });
    const disc = mesh(new THREE.CircleGeometry(0.09, 20), mat, 0, H + 0.73 - i * 0.28, 0.112);
    g.add(disc);
    g.add(mesh(new THREE.BoxGeometry(0.24, 0.03, 0.1), colorMat(0x1b1d1e, 0.6), 0, H + 0.84 - i * 0.28, 0.16));
  });
  return g;
}

function sign(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const H = n(P.altura, 1.8);
  const size = n(P.tamano, 0.9);
  const code = s(P.senal, 'stop');
  const { face, back } = signTextures(code, String(P.valor ?? '50'));
  g.add(mesh(new THREE.CylinderGeometry(0.038, 0.038, H + size, 10).translate(0, (H + size) / 2, 0), metal()));
  const plane = new THREE.PlaneGeometry(size, size);
  const fm = new THREE.MeshStandardMaterial({ map: face, alphaTest: 0.5, roughness: 0.5 });
  const bm = new THREE.MeshStandardMaterial({ map: back, alphaTest: 0.5, roughness: 0.6, metalness: 0.5 });
  g.add(mesh(plane, fm, 0, H + size / 2, 0.045));
  const b = mesh(plane, bm, 0, H + size / 2, 0.04);
  b.rotation.y = Math.PI;
  g.add(b);
  return g;
}

function billboard(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const W = n(P.ancho, 3);
  const Hh = n(P.alto, 1.5);
  const H = n(P.altura, 2);
  const tex = textTexture(s(P.texto, 'CARTEL'), s(P.fondo, '#1d5fbf'), '#ffffff', 1024, Math.round((1024 * Hh) / W));
  for (const x of [-W * 0.35, W * 0.35]) g.add(mesh(new THREE.BoxGeometry(0.08, H + Hh, 0.08).translate(0, (H + Hh) / 2, 0), metal(), x, 0, -0.06));
  const mats = [metal(), metal(), metal(), metal(), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.5 }), metal()];
  g.add(mesh(new THREE.BoxGeometry(W, Hh, 0.06), mats as unknown as THREE.Material, 0, H + Hh / 2, 0));
  return g;
}

function delineator(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const H = n(P.altura, 1.05);
  g.add(mesh(new THREE.BoxGeometry(0.1, H, 0.12).translate(0, H / 2, 0), colorMat(0xf2f2f0, 0.6)));
  g.add(mesh(new THREE.BoxGeometry(0.105, 0.25, 0.125), colorMat(0x151515, 0.6), 0, H - 0.3, 0));
  g.add(mesh(new THREE.BoxGeometry(0.05, 0.12, 0.01), new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0x552800 }), 0, H - 0.3, 0.068));
  return g;
}

function kmPost(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const tex = textTexture(`PK\n${s(P.pk, '12')}`, '#ffffff', '#111111', 256, 384);
  const mats = [colorMat(0xf0f0ec, 0.7), colorMat(0xf0f0ec, 0.7), colorMat(0xc8102e, 0.6), colorMat(0xf0f0ec, 0.7), new THREE.MeshStandardMaterial({ map: tex }), colorMat(0xf0f0ec, 0.7)];
  g.add(mesh(new THREE.BoxGeometry(0.4, 0.9, 0.15).translate(0, 0.45, 0), mats as unknown as THREE.Material));
  g.add(mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.15, 16, 1, false, 0, Math.PI).rotateX(Math.PI / 2).rotateZ(Math.PI / 2), colorMat(0xc8102e, 0.6), 0, 0.9, 0));
  return g;
}

// ---------------- Mobiliario ----------------

function bollard(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const H = n(P.altura, 1);
  const D = n(P.diametro, 0.15);
  const tipo = s(P.tipo, 'cilindro');
  const m = colorMat(s(P.color, '#2b3133'), 0.5, 0.4);
  if (tipo === 'bola') {
    g.add(mesh(new THREE.SphereGeometry(H / 2, 20, 14), colorMat(0xb8b2a6, 0.9), 0, H / 2, 0));
  } else if (tipo === 'flexible') {
    g.add(mesh(new THREE.CylinderGeometry(D / 2, D / 2, H, 14).translate(0, H / 2, 0), colorMat(0xd9d9d6, 0.5)));
    for (const y of [H - 0.1, H - 0.25]) g.add(mesh(new THREE.CylinderGeometry(D / 2 + 0.003, D / 2 + 0.003, 0.06, 14), colorMat(0xd0d6e0, 0.2, 0.6), 0, y, 0));
  } else {
    g.add(mesh(new THREE.CylinderGeometry(D / 2, D / 2, H, 14).translate(0, H / 2, 0), m));
    g.add(mesh(new THREE.SphereGeometry(D / 2, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), m, 0, H, 0));
  }
  return g;
}

function bench(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const L = n(P.largo, 1.8);
  const wood = colorMat(0x8a5f3a, 0.85);
  const m = darkMetal();
  for (let i = 0; i < 4; i++) g.add(mesh(new THREE.BoxGeometry(L, 0.035, 0.09), wood, 0, 0.45, -0.18 + i * 0.11));
  for (let i = 0; i < 3; i++) {
    const b = mesh(new THREE.BoxGeometry(L, 0.09, 0.035), wood, 0, 0.6 + i * 0.12, -0.27);
    b.rotation.x = -0.15;
    g.add(b);
  }
  for (const x of [-L / 2 + 0.15, L / 2 - 0.15]) {
    g.add(mesh(new THREE.BoxGeometry(0.06, 0.45, 0.5).translate(0, 0.225, 0), m, x, 0, -0.05));
    g.add(mesh(new THREE.BoxGeometry(0.06, 0.4, 0.05).translate(0, 0.2, 0), m, x, 0.45, -0.28));
  }
  return g;
}

function bin(): THREE.Object3D {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.2, 0.18, 0.7, 14).translate(0, 0.35 + 0.2, 0), colorMat(0x3d4f44, 0.6, 0.3)));
  g.add(mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8).translate(0, 0.3, 0), darkMetal(), 0, 0, -0.22));
  return g;
}

const CONT_COLORS: Record<string, number> = {
  resto: 0x5b5f5a,
  organico: 0x7a4e2a,
  envases: 0xe8c21e,
  papel: 0x2a5ea8,
  vidrio: 0x2f7a3a,
};

function container(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const tipo = s(P.tipo, 'resto');
  const m = colorMat(CONT_COLORS[tipo] ?? 0x5b5f5a, 0.55, 0.1);
  if (tipo === 'vidrio') {
    g.add(mesh(new THREE.SphereGeometry(0.85, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.5, 1), m));
    g.add(mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.1, 20).translate(0, 0.05, 0), m));
    return g;
  }
  g.add(mesh(new THREE.BoxGeometry(1.8, 1.35, 1.1).translate(0, 0.15 + 0.675, 0), m));
  const lid = mesh(new THREE.BoxGeometry(1.85, 0.1, 1.2), m, 0, 1.55, -0.05);
  lid.rotation.x = 0.08;
  g.add(lid);
  for (const x of [-0.75, 0.75]) for (const z of [-0.4, 0.4]) g.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 10).rotateZ(Math.PI / 2), colorMat(0x111111, 0.8), x, 0.08, z));
  return g;
}

function shelter(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const L = n(P.largo, 4);
  const m = metal();
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xcfe3ea, transparent: true, opacity: 0.25, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide });
  for (const x of [-L / 2, L / 2]) for (const z of [-0.75, 0.75]) g.add(mesh(new THREE.BoxGeometry(0.08, 2.5, 0.08).translate(0, 1.25, 0), m, x, 0, z));
  g.add(mesh(new THREE.BoxGeometry(L + 0.3, 0.1, 1.8), m, 0, 2.55, 0));
  g.add(mesh(new THREE.PlaneGeometry(L, 2.2), glass, 0, 1.2, -0.75));
  for (const x of [-L / 2, L / 2]) {
    const side = mesh(new THREE.PlaneGeometry(1.5, 2.2), glass, x, 1.2, 0);
    side.rotation.y = Math.PI / 2;
    g.add(side);
  }
  g.add(mesh(new THREE.BoxGeometry(L * 0.6, 0.05, 0.35), m, 0, 0.5, -0.5));
  return g;
}

function planter(P: Params, seed: number): THREE.Object3D {
  const g = new THREE.Group();
  const L = n(P.largo, 1.5);
  g.add(mesh(new THREE.BoxGeometry(L, 0.6, 0.8).translate(0, 0.3, 0), colorMat(0xa7a297, 0.9)));
  const r = rng(seed);
  for (let i = 0; i < Math.ceil(L * 2); i++) g.add(mesh(blob(0.3, seed + i), colorMat(0x4c6d2e, 0.95, 0, 'flat'), (r() - 0.5) * (L - 0.4), 0.75, (r() - 0.5) * 0.3));
  return g;
}

function rock(P: Params, seed: number): THREE.Object3D {
  const S = n(P.tamano, 1.2);
  const g = new THREE.Group();
  const b = mesh(blob(S / 2, seed, 0.3, 1), colorMat(0x8a837a, 1, 0, 'flat'), 0, S * 0.25, 0);
  b.scale.y = 0.65;
  g.add(b);
  return g;
}

function cone(): THREE.Object3D {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(0.38, 0.03, 0.38).translate(0, 0.015, 0), colorMat(0x1b1b1b, 0.8)));
  g.add(mesh(new THREE.ConeGeometry(0.14, 0.62, 16).translate(0, 0.34, 0), colorMat(0xff5a14, 0.6)));
  g.add(mesh(new THREE.CylinderGeometry(0.075, 0.095, 0.1, 16), colorMat(0xf4f4f4, 0.3), 0, 0.38, 0));
  return g;
}

function pole(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const H = n(P.altura, 8);
  const tipo = s(P.material, 'madera');
  const m = tipo === 'madera' ? colorMat(0x5b4430, 0.95) : tipo === 'hormigon' ? colorMat(0xb4b0a6, 0.85) : metal();
  g.add(mesh(new THREE.CylinderGeometry(0.11, 0.15, H, 10).translate(0, H / 2, 0), m));
  return g;
}

// ---------------- Construcciones ----------------

const facadeCache = new Map<string, THREE.CanvasTexture>();
function facadeTexture(windows: boolean, door: boolean) {
  const key = `${windows}|${door}`;
  let t = facadeCache.get(key);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  if (windows) {
    g.fillStyle = '#d8d4cc';
    g.fillRect(34, 28, 60, 64);
    g.fillStyle = '#3b4a57';
    g.fillRect(38, 32, 52, 56);
    g.fillStyle = '#7f95a6';
    g.fillRect(38, 32, 52, 6);
    g.fillStyle = '#d8d4cc';
    g.fillRect(62, 32, 4, 56);
  }
  if (door) {
    g.fillStyle = '#5c4433';
    g.fillRect(40, 40, 48, 88);
  }
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  facadeCache.set(key, t);
  return t;
}

/** Caja con UV en metros por cara (para texturas repetidas por planta). */
function boxMetric(w: number, h: number, d: number, cell: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const dims: [number, number][] = [
    [d, h],
    [d, h],
    [w, d],
    [w, d],
    [w, h],
    [w, h],
  ];
  for (let f = 0; f < 6; f++) {
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, (uv.getX(k) * dims[f][0]) / cell, (uv.getY(k) * dims[f][1]) / cell);
    }
  }
  return g;
}

function building(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const W = n(P.ancho, 10);
  const D = n(P.fondo, 8);
  const floors = Math.max(1, Math.round(n(P.plantas, 2)));
  const H = floors * 3;
  const col = s(P.color, '#e8dcc4');
  const wall = new THREE.MeshStandardMaterial({ color: col, map: facadeTexture(true, false), roughness: 0.9 });
  const top = colorMat(0x9c968c, 0.95);
  const mats = [wall, wall, top, top, wall, wall];
  g.add(mesh(boxMetric(W, H, D, 3).translate(0, H / 2, 0), mats as unknown as THREE.Material));
  // zócalo
  g.add(mesh(new THREE.BoxGeometry(W + 0.04, 0.6, D + 0.04).translate(0, 0.3 - 0.3, 0), colorMat(0x8f887d, 0.9)));
  if (s(P.tejado, 'dos_aguas') === 'dos_aguas') {
    const rh = Math.min(W, D) * 0.22;
    const shape = new THREE.Shape();
    shape.moveTo(-D / 2 - 0.3, 0);
    shape.lineTo(D / 2 + 0.3, 0);
    shape.lineTo(0, rh);
    shape.closePath();
    const roof = new THREE.ExtrudeGeometry(shape, { depth: W + 0.4, bevelEnabled: false });
    roof.translate(0, 0, -(W + 0.4) / 2);
    roof.rotateY(Math.PI / 2);
    g.add(mesh(roof, colorMat(s(P.color_tejado, '#9e4a32'), 0.85), 0, H, 0));
  } else {
    g.add(mesh(new THREE.BoxGeometry(W + 0.1, 0.4, D + 0.1), colorMat(0xd8d2c6, 0.9), 0, H + 0.2, 0));
  }
  return g;
}

function shed(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const W = n(P.ancho, 3);
  const D = n(P.fondo, 2.5);
  const H = n(P.alto, 2.5);
  const wall = new THREE.MeshStandardMaterial({ color: s(P.color, '#cfc6b4'), roughness: 0.95 });
  g.add(mesh(new THREE.BoxGeometry(W, H, D).translate(0, H / 2, 0), wall));
  g.add(mesh(new THREE.BoxGeometry(0.9, 2, 0.04), colorMat(0x6a5644, 0.8), 0, 1, D / 2 + 0.02));
  g.add(mesh(new THREE.BoxGeometry(W + 0.3, 0.12, D + 0.3), colorMat(0x7d7a74, 0.8), 0, H + 0.06, 0));
  return g;
}

// ---------------- Marcas viales puntuales ----------------

function flatMark(geo: THREE.BufferGeometry, y = 0.012) {
  const m = new THREE.Mesh(geo.rotateX(-Math.PI / 2), MAT.marking);
  m.position.y = y;
  m.receiveShadow = true;
  return m;
}

function crosswalk(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const W = n(P.ancho, 7);
  const D = n(P.profundidad, 4);
  const sw = 0.5;
  for (let x = -W / 2 + sw / 2; x <= W / 2 - sw / 2 + 1e-6; x += sw * 2) g.add(flatMark(new THREE.PlaneGeometry(sw, D).translate(x, 0, 0)));
  return g;
}

function stopLine(P: Params): THREE.Object3D {
  const g = new THREE.Group();
  const W = n(P.ancho, 3.5);
  const tipo = s(P.tipo, 'continua');
  if (tipo === 'continua') g.add(flatMark(new THREE.PlaneGeometry(W, 0.4)));
  else for (let x = -W / 2 + 0.4; x < W / 2; x += 1.6) g.add(flatMark(new THREE.PlaneGeometry(0.8, 0.4).translate(x, 0, 0)));
  if (P.texto_stop === true) {
    const tex = textTexture('STOP', 'rgba(0,0,0,0)', '#f2f2ee', 512, 1024);
    const ctx = (tex.image as HTMLCanvasElement).getContext('2d')!;
    ctx.clearRect(0, 0, 512, 1024);
    ctx.fillStyle = '#f2f2ee';
    ctx.font = 'bold 380px Arial';
    ctx.textAlign = 'center';
    ctx.save();
    ctx.scale(1, 2.5);
    ctx.fillText('STOP', 256, 300);
    ctx.restore();
    tex.needsUpdate = true;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 4).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.3 }));
    m.position.set(0, 0.013, 3);
    g.add(m);
  }
  return g;
}

function arrow(P: Params): THREE.Object3D {
  const tipo = s(P.tipo, 'recto');
  const L = n(P.largo, 5);
  const sh = new THREE.Shape();
  const w = 0.15;
  sh.moveTo(-w, -L / 2);
  sh.lineTo(w, -L / 2);
  if (tipo === 'recto') {
    sh.lineTo(w, L / 2 - 1.2);
    sh.lineTo(0.45, L / 2 - 1.2);
    sh.lineTo(0, L / 2);
    sh.lineTo(-0.45, L / 2 - 1.2);
    sh.lineTo(-w, L / 2 - 1.2);
  } else {
    const d = tipo === 'derecha' ? 1 : -1;
    sh.lineTo(w, L / 2 - 1.4);
    sh.lineTo(w + d * 0.5, L / 2 - 1.0);
    sh.lineTo(w + d * 0.35, L / 2 - 1.5);
    sh.lineTo(w + d * 1.1, L / 2 - 1.3);
    sh.lineTo(w + d * 0.75, L / 2 - 0.4);
    sh.lineTo(w + d * 0.62, L / 2 - 0.85);
    sh.lineTo(-w, L / 2 - 0.9);
  }
  sh.closePath();
  const geo = new THREE.ShapeGeometry(sh);
  // Shape está en XY con +Y = sentido de la flecha → tras rotar, apunta a −Z local
  const g = new THREE.Group();
  const m = flatMark(geo);
  m.rotation.z = 0;
  g.add(m);
  g.rotation.y = Math.PI;
  const wrap = new THREE.Group();
  wrap.add(g);
  return wrap;
}

// ---------------- Catálogo ----------------

const TREE_SPECIES: [string, string][] = [
  ['frondoso', 'Frondoso (encina, plátano…)'],
  ['pino', 'Pino carrasco'],
  ['pinonero', 'Pino piñonero'],
  ['conifera', 'Abeto / conífera'],
  ['cipres', 'Ciprés'],
  ['chopo', 'Chopo / álamo'],
  ['olivo', 'Olivo'],
  ['palmera', 'Palmera'],
  ['arbusto', 'Arbusto'],
];

export const CATALOG: Record<string, PropDef> = {
  arbol: {
    label: 'Árbol',
    category: 'Vegetación',
    fields: [
      sel('especie', 'Especie', TREE_SPECIES),
      num('altura', 'Altura', 'm', 0.3, 40, 0.1),
      num('tronco', 'Ø tronco', 'm', 0.02, 2, 0.01),
      num('copa', 'Ø copa', 'm', 0.3, 25, 0.1),
      sel('hoja', 'Follaje', [
        ['verde', 'Verde'],
        ['oscuro', 'Verde oscuro'],
        ['claro', 'Verde claro'],
        ['otono', 'Otoño'],
        ['seco', 'Seco'],
        ['sin_hoja', 'Sin hoja'],
      ]),
    ],
    defaults: { especie: 'frondoso', altura: 8, tronco: 0.35, copa: 5.5, hoja: 'verde' },
    build: tree,
  },
  roca: {
    label: 'Roca',
    category: 'Vegetación',
    fields: [num('tamano', 'Tamaño', 'm', 0.2, 10, 0.1)],
    defaults: { tamano: 1.2 },
    build: rock,
  },
  farola: {
    label: 'Farola',
    category: 'Iluminación y señales',
    fields: [
      sel('estilo', 'Estilo', [
        ['vial', 'Vial (brazo)'],
        ['clasica', 'Clásica (farol)'],
      ]),
      num('altura', 'Altura', 'm', 2, 20, 0.1),
      num('brazo', 'Brazo', 'm', 0.3, 4, 0.1),
      bool('doble', 'Doble brazo'),
      bool('encendida', 'Encendida'),
    ],
    defaults: { estilo: 'vial', altura: 8, brazo: 1.5, doble: false, encendida: false },
    build: streetlight,
  },
  semaforo: {
    label: 'Semáforo',
    category: 'Iluminación y señales',
    fields: [
      num('altura', 'Altura poste', 'm', 1.5, 7, 0.05),
      sel('estado', 'Estado', [
        ['rojo', 'Rojo'],
        ['ambar', 'Ámbar'],
        ['verde', 'Verde'],
        ['apagado', 'Apagado'],
      ]),
    ],
    defaults: { altura: 2.4, estado: 'rojo' },
    build: trafficLight,
  },
  senal: {
    label: 'Señal vertical',
    category: 'Iluminación y señales',
    fields: [
      sel('senal', 'Señal', Object.entries(SIGNS).map(([k, v]) => [k, v.label])),
      text('valor', 'Valor (velocidad)'),
      num('altura', 'Altura hasta la señal', 'm', 0.3, 6, 0.05),
      num('tamano', 'Tamaño', 'm', 0.3, 2, 0.05),
    ],
    defaults: { senal: 'stop', valor: '50', altura: 1.8, tamano: 0.9 },
    build: sign,
  },
  cartel: {
    label: 'Cartel / panel',
    category: 'Iluminación y señales',
    fields: [text('texto', 'Texto'), color('fondo', 'Color de fondo'), num('ancho', 'Ancho', 'm', 0.3, 15), num('alto', 'Alto', 'm', 0.2, 6), num('altura', 'Altura libre', 'm', 0, 8)],
    defaults: { texto: 'CARTEL', fondo: '#1d5fbf', ancho: 3, alto: 1.5, altura: 2 },
    build: billboard,
  },
  hito_arista: {
    label: 'Hito de arista',
    category: 'Iluminación y señales',
    fields: [num('altura', 'Altura', 'm', 0.5, 2)],
    defaults: { altura: 1.05 },
    build: delineator,
  },
  hito_km: {
    label: 'Hito kilométrico',
    category: 'Iluminación y señales',
    fields: [text('pk', 'Punto kilométrico')],
    defaults: { pk: '12' },
    build: kmPost,
  },
  bolardo: {
    label: 'Bolardo / pilona',
    category: 'Mobiliario urbano',
    fields: [
      sel('tipo', 'Tipo', [
        ['cilindro', 'Metálico'],
        ['flexible', 'Baliza flexible'],
        ['bola', 'Bola de piedra'],
      ]),
      num('altura', 'Altura', 'm', 0.2, 2),
      num('diametro', 'Diámetro', 'm', 0.05, 0.6, 0.01),
      color('color', 'Color'),
    ],
    defaults: { tipo: 'cilindro', altura: 1, diametro: 0.12, color: '#2b3133' },
    build: bollard,
  },
  banco: { label: 'Banco', category: 'Mobiliario urbano', fields: [num('largo', 'Largo', 'm', 0.5, 6)], defaults: { largo: 1.8 }, build: bench },
  papelera: { label: 'Papelera', category: 'Mobiliario urbano', fields: [], defaults: {}, build: bin },
  contenedor: {
    label: 'Contenedor',
    category: 'Mobiliario urbano',
    fields: [
      sel('tipo', 'Tipo', [
        ['resto', 'Resto'],
        ['organico', 'Orgánico'],
        ['envases', 'Envases'],
        ['papel', 'Papel'],
        ['vidrio', 'Vidrio (iglú)'],
      ]),
    ],
    defaults: { tipo: 'resto' },
    build: container,
  },
  marquesina: { label: 'Marquesina de autobús', category: 'Mobiliario urbano', fields: [num('largo', 'Largo', 'm', 2, 10)], defaults: { largo: 4 }, build: shelter },
  jardinera: { label: 'Jardinera', category: 'Mobiliario urbano', fields: [num('largo', 'Largo', 'm', 0.5, 6)], defaults: { largo: 1.5 }, build: planter },
  cono: { label: 'Cono de tráfico', category: 'Mobiliario urbano', fields: [], defaults: {}, build: cone },
  poste: {
    label: 'Poste',
    category: 'Construcciones',
    fields: [
      num('altura', 'Altura', 'm', 1, 30, 0.1),
      sel('material', 'Material', [
        ['madera', 'Madera'],
        ['hormigon', 'Hormigón'],
        ['metalico', 'Metálico'],
      ]),
    ],
    defaults: { altura: 8, material: 'madera' },
    build: pole,
  },
  edificio: {
    label: 'Edificio',
    category: 'Construcciones',
    fields: [
      num('ancho', 'Ancho (fachada)', 'm', 2, 100, 0.1),
      num('fondo', 'Fondo', 'm', 2, 100, 0.1),
      num('plantas', 'Plantas', '', 1, 30, 1),
      color('color', 'Color fachada'),
      sel('tejado', 'Cubierta', [
        ['dos_aguas', 'Tejado a dos aguas'],
        ['plano', 'Azotea'],
      ]),
      color('color_tejado', 'Color tejado'),
    ],
    defaults: { ancho: 10, fondo: 8, plantas: 2, color: '#e8dcc4', tejado: 'dos_aguas', color_tejado: '#9e4a32' },
    build: building,
  },
  caseta: {
    label: 'Caseta',
    category: 'Construcciones',
    fields: [num('ancho', 'Ancho', 'm', 1, 20), num('fondo', 'Fondo', 'm', 1, 20), num('alto', 'Alto', 'm', 1, 6), color('color', 'Color')],
    defaults: { ancho: 3, fondo: 2.5, alto: 2.5, color: '#cfc6b4' },
    build: shed,
  },
  paso_peatones: {
    label: 'Paso de peatones',
    category: 'Marcas viales',
    fields: [num('ancho', 'Longitud (ancho de calzada)', 'm', 2, 40, 0.1), num('profundidad', 'Ancho de franjas', 'm', 2, 10, 0.1)],
    defaults: { ancho: 7, profundidad: 4 },
    build: crosswalk,
    onSurface: true,
  },
  linea_detencion: {
    label: 'Línea de detención',
    category: 'Marcas viales',
    fields: [
      num('ancho', 'Longitud', 'm', 1, 20, 0.1),
      sel('tipo', 'Tipo', [
        ['continua', 'Continua (STOP)'],
        ['discontinua', 'Discontinua (ceda)'],
      ]),
      bool('texto_stop', 'Rótulo STOP'),
    ],
    defaults: { ancho: 3.5, tipo: 'continua', texto_stop: true },
    build: stopLine,
    onSurface: true,
  },
  flecha: {
    label: 'Flecha en calzada',
    category: 'Marcas viales',
    fields: [
      sel('tipo', 'Tipo', [
        ['recto', 'Recto'],
        ['derecha', 'Giro a la derecha'],
        ['izquierda', 'Giro a la izquierda'],
      ]),
      num('largo', 'Largo', 'm', 2, 10, 0.1),
    ],
    defaults: { tipo: 'recto', largo: 5 },
    build: arrow,
    onSurface: true,
  },
};

export const CATEGORIES = [...new Set(Object.values(CATALOG).map((d) => d.category))];

export function buildProp(type: string, params: Params, seed: number): THREE.Object3D {
  const def = CATALOG[type];
  if (!def) return new THREE.Group();
  return def.build({ ...def.defaults, ...params }, seed);
}
