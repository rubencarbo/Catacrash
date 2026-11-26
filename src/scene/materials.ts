import * as THREE from 'three';
import { patchOverlay } from './overlay';
import { rng } from './utils';

/** Textura de ruido procedural (sin descargas: todo se genera en el navegador). */
export function noiseTexture(
  base: [number, number, number],
  variance: number,
  opts: { size?: number; seed?: number; speckles?: number; streaks?: boolean } = {},
): THREE.CanvasTexture {
  const size = opts.size ?? 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  const r = rng(opts.seed ?? 7);
  for (let i = 0; i < size * size; i++) {
    const n = (r() - 0.5) * variance;
    img.data[i * 4] = Math.max(0, Math.min(255, base[0] + n));
    img.data[i * 4 + 1] = Math.max(0, Math.min(255, base[1] + n));
    img.data[i * 4 + 2] = Math.max(0, Math.min(255, base[2] + n));
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const sp = opts.speckles ?? 0;
  for (let i = 0; i < sp; i++) {
    const v = r() > 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${0.05 + r() * 0.12})`;
    const s = 1 + r() * 3;
    g.fillRect(r() * size, r() * size, s, s);
  }
  if (opts.streaks) {
    for (let i = 0; i < 18; i++) {
      g.fillStyle = `rgba(0,0,0,${0.03 + r() * 0.05})`;
      g.fillRect(r() * size, 0, 2 + r() * 10, size);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Adoquinado (1 unidad UV = 4 m como el resto de pavimentos). */
function paverTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6f6a62';
  g.fillRect(0, 0, 256, 256);
  const r = rng(21);
  const bw = 256 / 20; // 20 cm
  const bh = 256 / 40; // 10 cm
  for (let row = 0; row < 40; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let x = -bw; x < 256 + bw; x += bw) {
      const v = 120 + r() * 40;
      g.fillStyle = `rgb(${v},${v * 0.95},${v * 0.88})`;
      g.fillRect(x + off + 0.6, row * bh + 0.6, bw - 1.2, bh - 1.2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Cebreado: franjas blancas de 50 cm cada 1,5 m sobre asfalto (escala 4 m por repetición). */
function hatchTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const img = g.createImageData(256, 256);
  const r = rng(22);
  for (let i = 0; i < 256 * 256; i++) {
    const n = 78 + (r() - 0.5) * 30;
    img.data[i * 4] = img.data[i * 4 + 1] = n;
    img.data[i * 4 + 2] = n + 2;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#efefe9';
  const per = 256 / (4 / 1.5);
  for (let x = 0; x < 256; x += per) g.fillRect(x, 0, (256 / 4) * 0.5, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function std(params: THREE.MeshStandardMaterialParameters) {
  return new THREE.MeshStandardMaterial(params);
}

const asphaltTex = {
  nuevo: noiseTexture([58, 58, 60], 28, { seed: 1, speckles: 1200 }),
  normal: noiseTexture([78, 78, 80], 34, { seed: 2, speckles: 2200, streaks: true }),
  desgastado: noiseTexture([104, 102, 98], 44, { seed: 3, speckles: 3800, streaks: true }),
};

/** Materiales compartidos. Los de suelo admiten calcos. */
export const MAT = {
  asphalt: {
    nuevo: std({ map: asphaltTex.nuevo, roughness: 0.92 }),
    normal: std({ map: asphaltTex.normal, roughness: 0.95 }),
    desgastado: std({ map: asphaltTex.desgastado, roughness: 0.97 }),
  },
  bike: std({ map: noiseTexture([150, 62, 52], 30, { seed: 4, speckles: 900 }), roughness: 0.9 }),
  parking: std({ map: noiseTexture([86, 86, 88], 34, { seed: 5, speckles: 2000 }), roughness: 0.95 }),
  sidewalk: std({ map: noiseTexture([178, 172, 162], 26, { seed: 6, speckles: 600 }), roughness: 0.9 }),
  curb: std({ color: 0xc9c6bf, roughness: 0.85 }),
  earth: std({ map: noiseTexture([132, 108, 78], 50, { seed: 8, speckles: 2500 }), roughness: 1 }),
  gravel: std({ map: noiseTexture([150, 140, 122], 70, { seed: 9, speckles: 5000 }), roughness: 1 }),
  grass: std({ map: noiseTexture([96, 122, 62], 40, { seed: 10, speckles: 1500 }), roughness: 1 }),
  berm: std({ map: noiseTexture([128, 120, 92], 46, { seed: 13, speckles: 2600 }), roughness: 1 }),
  paver: std({ map: paverTexture(), roughness: 0.9 }),
  hatch: std({ map: hatchTexture(), roughness: 0.92 }),
  marking: std({ color: 0xf2f2ee, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  terrain: std({
    map: noiseTexture([200, 200, 200], 60, { seed: 11, speckles: 3000 }),
    vertexColors: true,
    roughness: 1,
  }),
  water: new THREE.MeshPhysicalMaterial({
    color: 0x2f5560,
    roughness: 0.08,
    metalness: 0.0,
    transmission: 0,
    transparent: true,
    opacity: 0.82,
    normalMap: noiseTexture([128, 128, 255], 40, { seed: 12, size: 256 }),
    normalScale: new THREE.Vector2(0.25, 0.25),
  }),
};

MAT.water.normalMap!.colorSpace = THREE.NoColorSpace;

for (const m of [MAT.asphalt.nuevo, MAT.asphalt.normal, MAT.asphalt.desgastado, MAT.bike, MAT.parking, MAT.sidewalk, MAT.curb, MAT.earth, MAT.gravel, MAT.grass, MAT.berm, MAT.paver, MAT.hatch]) {
  patchOverlay(m, 'road');
}
patchOverlay(MAT.terrain, 'ground');

/** Aspecto de firme mojado: menos rugosidad y tono más oscuro. */
export function setWet(wet: boolean) {
  const road = [MAT.asphalt.nuevo, MAT.asphalt.normal, MAT.asphalt.desgastado, MAT.bike, MAT.parking, MAT.hatch];
  for (const m of road) {
    m.roughness = wet ? 0.28 : 0.94;
    m.color.setScalar(wet ? 0.62 : 1);
  }
  for (const m of [MAT.sidewalk, MAT.curb, MAT.earth, MAT.gravel, MAT.berm, MAT.paver]) {
    m.roughness = wet ? 0.5 : 0.95;
    m.color.setScalar(wet ? 0.72 : 1);
  }
  MAT.terrain.color.setScalar(wet ? 0.82 : 1);
}

// Caché de materiales simples por color.
const colorCache = new Map<string, THREE.MeshStandardMaterial>();
export function colorMat(color: THREE.ColorRepresentation, roughness = 0.8, metalness = 0, extra = ''): THREE.MeshStandardMaterial {
  const key = `${new THREE.Color(color).getHexString()}|${roughness}|${metalness}|${extra}`;
  let m = colorCache.get(key);
  if (!m) {
    m = std({ color, roughness, metalness });
    if (extra.includes('double')) m.side = THREE.DoubleSide;
    if (extra.includes('flat')) m.flatShading = true;
    colorCache.set(key, m);
  }
  return m;
}
