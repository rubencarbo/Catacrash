import * as THREE from 'three';
import type { PathSample } from './spline';

/** Acumulador de geometría para mallas generadas a lo largo de un trazado. */
export class GeoBuf {
  pos: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  get count() {
    return this.pos.length / 3;
  }

  /**
   * Banda horizontal: para cada muestra se colocan vértices en los desplazamientos laterales
   * `offsets` (en orden creciente, + = derecha) con cota relativa `h(o)`.
   */
  strip(
    S: PathSample[],
    offsets: number[],
    h: (o: number, k: number) => number,
    uvScale = 4,
    keep?: (x: number, z: number) => boolean,
  ) {
    const base = this.count;
    const cols = offsets.length;
    for (let k = 0; k < S.length; k++) {
      const s = S[k];
      const nx = -s.tz;
      const nz = s.tx;
      for (const o of offsets) {
        this.pos.push(s.x + nx * o, s.y + h(o, k), s.z + nz * o);
        this.uv.push(o / uvScale, s.s / uvScale);
      }
    }
    for (let k = 0; k < S.length - 1; k++) {
      for (let m = 0; m < cols - 1; m++) {
        const a = base + k * cols + m;
        const b = a + 1;
        const c = a + cols;
        const d = c + 1;
        if (keep) {
          const p = this.pos;
          const cx = (p[a * 3] + p[b * 3] + p[c * 3] + p[d * 3]) / 4;
          const cz = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2] + p[d * 3 + 2]) / 4;
          if (!keep(cx, cz)) continue;
        }
        this.idx.push(a, b, c, b, d, c);
      }
    }
  }

  /** Cara vertical a lo largo del trazado en el desplazamiento `o`, entre dos cotas relativas. */
  wall(
    S: PathSample[],
    o: number,
    yLow: (k: number) => number,
    yHigh: (k: number) => number,
    faceRight: boolean,
    absolute = false,
    uvScale = 1,
    keep?: (x: number, z: number) => boolean,
  ) {
    const base = this.count;
    for (let k = 0; k < S.length; k++) {
      const s = S[k];
      const x = s.x - s.tz * o;
      const z = s.z + s.tx * o;
      const y0 = (absolute ? 0 : s.y) + yLow(k);
      const y1 = (absolute ? 0 : s.y) + yHigh(k);
      this.pos.push(x, y0, z, x, y1, z);
      this.uv.push(s.s / uvScale, y0 / uvScale, s.s / uvScale, y1 / uvScale);
    }
    for (let k = 0; k < S.length - 1; k++) {
      const b0 = base + k * 2;
      const t0 = b0 + 1;
      const b1 = b0 + 2;
      const t1 = b0 + 3;
      if (keep) {
        const p = this.pos;
        if (!keep((p[b0 * 3] + p[b1 * 3]) / 2, (p[b0 * 3 + 2] + p[b1 * 3 + 2]) / 2)) continue;
      }
      if (faceRight) this.idx.push(b0, b1, t0, b1, t1, t0);
      else this.idx.push(b0, t0, b1, b1, t0, t1);
    }
  }

  /** Cuadrilátero suelto (4 vértices en orden antihorario visto desde la cara). */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, uvs?: number[]) {
    const base = this.count;
    for (const p of [a, b, c, d]) this.pos.push(p.x, p.y, p.z);
    this.uv.push(...(uvs ?? [0, 0, 1, 0, 1, 1, 0, 1]));
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }

  mesh(mat: THREE.Material, entityId?: string): THREE.Mesh {
    const m = new THREE.Mesh(this.build(), mat);
    if (entityId) m.userData.entityId = entityId;
    return m;
  }
}

/**
 * Extrusión de un perfil 2D (lateral, altura) a lo largo del trazado.
 * `ground(k)` = cota de apoyo en cada muestra.
 */
export function extrude(
  S: PathSample[],
  profile: [number, number][],
  ground: (k: number) => number,
  closed = false,
  uvScale = 1,
): THREE.BufferGeometry {
  const g = new GeoBuf();
  const cols = profile.length;
  // perímetro acumulado para la coordenada v
  const per: number[] = [0];
  for (let i = 1; i < cols; i++)
    per.push(per[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  for (let k = 0; k < S.length; k++) {
    const s = S[k];
    const nx = -s.tz;
    const nz = s.tx;
    const y = ground(k);
    for (let i = 0; i < cols; i++) {
      const [o, h] = profile[i];
      g.pos.push(s.x + nx * o, y + h, s.z + nz * o);
      g.uv.push(s.s / uvScale, per[i] / uvScale);
    }
  }
  const segs = closed ? cols : cols - 1;
  for (let k = 0; k < S.length - 1; k++) {
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % cols;
      const a = k * cols + i;
      const b = k * cols + i2;
      const c = (k + 1) * cols + i;
      const d = (k + 1) * cols + i2;
      g.idx.push(a, c, b, b, c, d);
    }
  }
  return g.build();
}
