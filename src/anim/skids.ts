import * as THREE from 'three';
import type { MarkStrip } from '../physics/sim';

const skidMat = new THREE.MeshStandardMaterial({
  color: 0x0c0c0c,
  roughness: 0.9,
  transparent: true,
  opacity: 0.6,
  depthWrite: false,
  polygonOffset: true,
  polygonOffsetFactor: -4,
  polygonOffsetUnits: -4,
});

export interface Skids {
  group: THREE.Group;
  /** Muestra solo la parte de las huellas ya producida en el instante t. */
  update(t: number): void;
}

/**
 * Huellas de neumáticos a partir de los tramos en que la simulación detectó deslizamiento
 * (rueda bloqueada o derrape lateral). Aparecen a medida que se producen.
 */
export function buildSkids(strips: MarkStrip[], surfaceH: (x: number, z: number) => number): Skids | null {
  if (!strips.length) return null;
  const group = new THREE.Group();
  const items: { mesh: THREE.Mesh; times: number[] }[] = [];
  for (const st of strips) {
    const P = st.pts;
    if (P.length < 3) continue;
    const pos: number[] = [];
    const half = st.width / 2;
    for (let i = 0; i < P.length; i++) {
      const a = P[Math.max(0, i - 1)];
      const b = P[Math.min(P.length - 1, i + 1)];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      const nx = -dz * half;
      const nz = dx * half;
      const y = surfaceH(P[i].x, P[i].z) + 0.02;
      pos.push(P[i].x - nx, y, P[i].z - nz, P[i].x + nx, y, P[i].z + nz);
    }
    const idx: number[] = [];
    for (let i = 0; i < P.length - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, skidMat);
    mesh.renderOrder = 3;
    mesh.receiveShadow = true;
    mesh.userData.skid = true;
    group.add(mesh);
    items.push({ mesh, times: P.map((p) => p.t) });
  }
  return {
    group,
    update(t: number) {
      for (const { mesh, times } of items) {
        let n = 0;
        while (n < times.length && times[n] <= t) n++;
        mesh.geometry.setDrawRange(0, Math.max(0, (n - 1) * 6));
        mesh.visible = n > 1;
      }
    },
  };
}
