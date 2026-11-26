import * as THREE from 'three';
import type { TerrainData } from '../model/types';
import { MAT } from './materials';
import type { PathSample } from './spline';
import { clamp, smoothstep, valueNoise2D } from './utils';

/** Franja que una carretera o un río imponen sobre el terreno. */
export interface Corridor {
  samples: PathSample[];
  halfL: number;
  halfR: number;
  /** Anchura de transición con el terreno natural (talud / orilla). */
  talud: number;
  /** Cota relativa al eje según el desplazamiento lateral firmado (izq. < 0). */
  heightAt: (o: number) => number;
  /** Cuánto queda el terreno por debajo de la superficie dentro de la franja. */
  inset: number;
}

export type SculptMode = 'subir' | 'bajar' | 'suavizar' | 'aplanar' | 'cota';

const GRASS = new THREE.Color(0x6b7f45);
const DRY = new THREE.Color(0x9a8f5c);
const DIRT = new THREE.Color(0x8a7356);
const ROCK = new THREE.Color(0x857d74);

/**
 * Terreno como malla regular de alturas. `base` es lo que modela el usuario;
 * `final` añade las explanaciones de carreteras y cauces de ríos.
 */
export class Terrain {
  size: number;
  segs: number;
  n: number;
  step: number;
  half: number;
  base: Float32Array;
  final: Float32Array;
  geometry: THREE.BufferGeometry;
  mesh: THREE.Mesh;
  private noise: Float32Array;
  minH = 0;
  maxH = 0;

  constructor(data: TerrainData) {
    this.size = data.size;
    this.segs = data.segs;
    this.n = data.segs + 1;
    this.step = data.size / data.segs;
    this.half = data.size / 2;
    this.base = data.base;
    this.final = new Float32Array(this.base);

    const n = this.n;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    const col = new Float32Array(n * n * 3);
    this.noise = new Float32Array(n * n);
    const vn = valueNoise2D(99);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        pos[k * 3] = x;
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / 6;
        uv[k * 2 + 1] = -z / 6;
        this.noise[k] = vn(x / 14, z / 14) * 0.6 + vn(x / 4, z / 4) * 0.4;
      }
    }
    const idx = new Uint32Array(this.segs * this.segs * 6);
    let t = 0;
    for (let j = 0; j < this.segs; j++) {
      for (let i = 0; i < this.segs; i++) {
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx[t++] = a;
        idx[t++] = c;
        idx[t++] = b;
        idx[t++] = b;
        idx[t++] = c;
        idx[t++] = d;
      }
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geometry.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh = new THREE.Mesh(this.geometry, MAT.terrain);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terreno';
    this.mesh.userData.isTerrain = true;
  }

  dispose() {
    this.geometry.dispose();
  }

  // ---------- consulta de alturas ----------
  private sample(arr: Float32Array, x: number, z: number) {
    const fx = clamp((x + this.half) / this.step, 0, this.segs - 1e-6);
    const fz = clamp((z + this.half) / this.step, 0, this.segs - 1e-6);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const n = this.n;
    const a = arr[j * n + i];
    const b = arr[j * n + i + 1];
    const c = arr[(j + 1) * n + i];
    const d = arr[(j + 1) * n + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  /** Altura final (con carreteras y ríos). */
  height(x: number, z: number) {
    return this.sample(this.final, x, z);
  }
  /** Altura del terreno natural modelado. */
  baseHeight(x: number, z: number) {
    return this.sample(this.base, x, z);
  }
  inside(x: number, z: number) {
    return Math.abs(x) <= this.half && Math.abs(z) <= this.half;
  }

  /** Intersección rayo-terreno por avance + bisección (mucho más rápido que el raycast de malla). */
  raycast(ray: THREE.Ray): THREE.Vector3 | null {
    const box = new THREE.Box3(
      new THREE.Vector3(-this.half, this.minH - 2, -this.half),
      new THREE.Vector3(this.half, this.maxH + 2, this.half),
    );
    const enter = new THREE.Vector3();
    let t0: number;
    if (box.containsPoint(ray.origin)) t0 = 0;
    else {
      if (!ray.intersectBox(box, enter)) return null;
      t0 = enter.distanceTo(ray.origin);
    }
    const p = new THREE.Vector3();
    const stepLen = Math.max(0.25, this.step * 0.5);
    let prevT = t0;
    for (let t = t0; t < t0 + 6000; t += stepLen) {
      ray.at(t, p);
      if (!this.inside(p.x, p.z)) {
        if (t > t0) break;
        continue;
      }
      if (p.y <= this.height(p.x, p.z)) {
        let lo = prevT;
        let hi = t;
        for (let k = 0; k < 18; k++) {
          const m = (lo + hi) / 2;
          ray.at(m, p);
          if (p.y <= this.height(p.x, p.z)) hi = m;
          else lo = m;
        }
        ray.at(hi, p);
        p.y = this.height(p.x, p.z);
        return p;
      }
      prevT = t;
    }
    return null;
  }

  // ---------- explanaciones ----------
  /** Recalcula `final` a partir de `base` y las franjas de carreteras/ríos. */
  rebuild(corridors: Corridor[]) {
    this.final.set(this.base);
    for (const c of corridors) this.applyCorridor(c);
    this.updateGeometry();
  }

  private applyCorridor(c: Corridor) {
    const S = c.samples;
    if (S.length < 2) return;
    const n = this.n;
    const reach = Math.max(c.halfL, c.halfR) + c.talud;
    const best = new Map<number, { d: number; o: number; y: number }>();
    for (let k = 0; k < S.length - 1; k++) {
      const a = S[k];
      const b = S[k + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-9) continue;
      const l = Math.sqrt(l2);
      const nx = -dz / l;
      const nz = dx / l;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach + this.half) / this.step));
      const i1 = Math.min(this.segs, Math.ceil((Math.max(a.x, b.x) + reach + this.half) / this.step));
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach + this.half) / this.step));
      const j1 = Math.min(this.segs, Math.ceil((Math.max(a.z, b.z) + reach + this.half) / this.step));
      for (let j = j0; j <= j1; j++) {
        const pz = -this.half + j * this.step;
        for (let i = i0; i <= i1; i++) {
          const px = -this.half + i * this.step;
          let t = ((px - a.x) * dx + (pz - a.z) * dz) / l2;
          // No prolongar la franja más allá de los extremos del trazado.
          if ((k === 0 && t < 0) || (k === S.length - 2 && t > 1)) continue;
          t = clamp(t, 0, 1);
          const cx = a.x + dx * t;
          const cz = a.z + dz * t;
          const d = Math.hypot(px - cx, pz - cz);
          if (d > reach) continue;
          const v = j * n + i;
          const cur = best.get(v);
          if (!cur || d < cur.d) {
            const o = (px - cx) * nx + (pz - cz) * nz;
            best.set(v, { d, o, y: a.y + (b.y - a.y) * t });
          }
        }
      }
    }
    for (const [v, { d, o, y }] of best) {
      const half = o < 0 ? c.halfL : c.halfR;
      if (d <= half) {
        this.final[v] = y + c.heightAt(o) - c.inset;
      } else {
        const sign = o < 0 ? -1 : 1;
        const edge = y + c.heightAt(sign * half) - c.inset * 0.5;
        const w = smoothstep((d - half) / Math.max(0.01, c.talud));
        this.final[v] = edge + (this.final[v] - edge) * w;
      }
    }
  }

  updateGeometry() {
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = pos.array as Float32Array;
    let mn = Infinity;
    let mx = -Infinity;
    for (let k = 0; k < this.final.length; k++) {
      const h = this.final[k];
      arr[k * 3 + 1] = h;
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
    this.minH = mn;
    this.maxH = mx;
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
    this.updateColors();
  }

  private updateColors() {
    const nrm = this.geometry.getAttribute('normal') as THREE.BufferAttribute;
    const col = this.geometry.getAttribute('color') as THREE.BufferAttribute;
    const c = new THREE.Color();
    for (let k = 0; k < this.final.length; k++) {
      const ny = nrm.getY(k);
      const slope = 1 - ny; // 0 = llano
      const nz = this.noise[k];
      c.copy(GRASS).lerp(DRY, clamp(0.35 + nz * 0.8, 0, 1));
      // Desmontes y terraplenes recién hechos: tierra
      const cut = Math.abs(this.final[k] - this.base[k]);
      if (cut > 0.15) c.lerp(DIRT, clamp((cut - 0.15) * 0.8, 0, 0.75));
      if (slope > 0.12) c.lerp(DIRT, clamp((slope - 0.12) * 4, 0, 1));
      if (slope > 0.35) c.lerp(ROCK, clamp((slope - 0.35) * 3, 0, 1));
      col.setXYZ(k, c.r, c.g, c.b);
    }
    col.needsUpdate = true;
  }

  // ---------- modelado ----------
  sculpt(x: number, z: number, mode: SculptMode, radius: number, strength: number, target: number) {
    const n = this.n;
    const i0 = Math.max(0, Math.floor((x - radius + this.half) / this.step));
    const i1 = Math.min(this.segs, Math.ceil((x + radius + this.half) / this.step));
    const j0 = Math.max(0, Math.floor((z - radius + this.half) / this.step));
    const j1 = Math.min(this.segs, Math.ceil((z + radius + this.half) / this.step));
    const src = mode === 'suavizar' ? new Float32Array(this.base) : this.base;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = -this.half + i * this.step;
        const pz = -this.half + j * this.step;
        const d = Math.hypot(px - x, pz - z) / radius;
        if (d >= 1) continue;
        const f = 0.5 + 0.5 * Math.cos(Math.PI * d);
        const v = j * n + i;
        const h = this.base[v];
        switch (mode) {
          case 'subir':
            this.base[v] = h + strength * f;
            break;
          case 'bajar':
            this.base[v] = h - strength * f;
            break;
          case 'aplanar':
          case 'cota':
            this.base[v] = h + (target - h) * clamp(strength * f, 0, 1);
            break;
          case 'suavizar': {
            let sum = 0;
            let cnt = 0;
            for (let dj = -2; dj <= 2; dj++)
              for (let di = -2; di <= 2; di++) {
                const ii = i + di;
                const jj = j + dj;
                if (ii < 0 || jj < 0 || ii > this.segs || jj > this.segs) continue;
                sum += src[jj * n + ii];
                cnt++;
              }
            this.base[v] = h + (sum / cnt - h) * clamp(strength * f * 2, 0, 1);
            break;
          }
        }
      }
    }
  }
}
