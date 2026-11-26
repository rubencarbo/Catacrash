import * as THREE from 'three';
import type { VehicleEntity } from '../model/types';
import { TWO_WHEELS } from '../vehicles/spec';
import type { Motion } from './motion';

const skidMat = new THREE.MeshStandardMaterial({
  color: 0x0c0c0c,
  roughness: 0.9,
  transparent: true,
  opacity: 0.62,
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
 * Huellas de neumáticos en los tramos marcados: se sigue la posición de cada rueda,
 * así que las frenadas rectas salen paralelas y los derrapes describen arcos.
 */
export function buildSkids(e: VehicleEntity, m: Motion, surfaceH: (x: number, z: number) => number): Skids | null {
  const segs = m.segments.filter((s) => s.marks);
  if (!segs.length) return null;
  const sp = e.spec;
  const two = TWO_WHEELS.includes(sp.tipo);
  const tyre = Math.min(0.3, Math.max(0.1, sp.W * 0.11));
  const zF = -sp.L / 2 + sp.volD;
  const zR = sp.L / 2 - sp.volT;
  const wheels: [number, number][] = two
    ? [
        [0, zF],
        [0, zR],
      ]
    : [
        [-sp.viaD / 2, zF],
        [sp.viaD / 2, zF],
        [-sp.viaT / 2, zR],
        [sp.viaT / 2, zR],
      ];
  const group = new THREE.Group();
  const strips: { mesh: THREE.Mesh; times: number[] }[] = [];
  const DT = 0.02;
  for (const s of segs) {
    const times: number[] = [];
    for (let t = s.t0; t <= s.t1 + 1e-6; t += DT) times.push(Math.min(t, s.t1));
    const poses = times.map((t) => m.pose(t));
    for (const [wx, wz] of wheels) {
      const P = poses.map((p) => {
        const a = (p.heading * Math.PI) / 180;
        // local → mundo: frontal −Z gira con el rumbo
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const x = p.x + wx * c - wz * sn;
        const z = p.z + wx * sn + wz * c;
        return new THREE.Vector3(x, surfaceH(x, z) + 0.018, z);
      });
      const pos: number[] = [];
      for (let i = 0; i < P.length; i++) {
        const a = P[Math.max(0, i - 1)];
        const b = P[Math.min(P.length - 1, i + 1)];
        let dx = b.x - a.x;
        let dz = b.z - a.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        const nx = -dz * (tyre / 2);
        const nz = dx * (tyre / 2);
        pos.push(P[i].x - nx, P[i].y, P[i].z - nz, P[i].x + nx, P[i].y, P[i].z + nz);
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
      strips.push({ mesh, times });
    }
  }
  return {
    group,
    update(t: number) {
      for (const { mesh, times } of strips) {
        let n = 0;
        while (n < times.length && times[n] <= t) n++;
        mesh.geometry.setDrawRange(0, Math.max(0, (n - 1) * 6));
        mesh.visible = n > 1;
      }
    },
  };
}
