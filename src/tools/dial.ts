import * as THREE from 'three';
import type { Entity, VehicleEntity } from '../model/types';
import type { World } from '../scene/world';

/**
 * Dial de orientación alrededor del vehículo u objeto seleccionado: un anillo en el suelo y una
 * flecha delante. Arrastrar la flecha lo gira; arrastrar la carrocería lo mueve.
 */
export class Dial {
  group = new THREE.Group();
  private ring: THREE.LineLoop;
  private knob: THREE.Mesh;
  private hit: THREE.Mesh;
  private stem: THREE.Line;
  private id: string | null = null;
  private R = 3;

  constructor(
    scene: THREE.Scene,
    private world: World,
  ) {
    const circle: THREE.Vector3[] = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      circle.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
    }
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(circle), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.06, gapSize: 0.04, transparent: true, opacity: 0.75, depthTest: false }));
    this.ring.computeLineDistances();
    // flecha plana (apunta hacia −z, el frontal)
    const sh = new THREE.Shape();
    sh.moveTo(0, -0.9);
    sh.lineTo(0.62, 0);
    sh.lineTo(0.24, 0);
    sh.lineTo(0.24, 0.55);
    sh.lineTo(-0.24, 0.55);
    sh.lineTo(-0.24, 0);
    sh.lineTo(-0.62, 0);
    sh.closePath();
    const g = new THREE.ShapeGeometry(sh).rotateX(Math.PI / 2);
    this.knob = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false, side: THREE.DoubleSide }));
    this.hit = new THREE.Mesh(new THREE.CircleGeometry(1.1, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ visible: false }));
    this.stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.8, depthTest: false }));
    for (const o of [this.ring, this.knob, this.stem]) o.renderOrder = 12;
    this.group.add(this.ring, this.stem, this.knob, this.hit);
    this.group.visible = false;
    scene.add(this.group);
  }

  private mark: string | null = null;
  /** Objeto que rodea el dial: el vehículo/objeto o una posición del croquis. */
  private obj() {
    if (!this.id) return undefined;
    return this.mark ? this.world.markObject(this.id, this.mark) : this.world.objects.get(this.id);
  }

  show(e: Entity | null | undefined, mark?: string) {
    this.id = null;
    this.mark = mark ?? null;
    this.group.visible = false;
    if (!e || e.hidden || (e.kind !== 'vehicle' && e.kind !== 'prop')) return;
    const obj = mark ? this.world.markObject(e.id, mark) : this.world.objects.get(e.id);
    if (!obj) return;
    if (e.kind === 'vehicle') {
      const sp = (e as VehicleEntity).spec;
      this.R = Math.hypot(sp.L, sp.W) / 2 + 0.7;
    } else {
      const s = new THREE.Sphere();
      new THREE.Box3().setFromObject(obj).getBoundingSphere(s);
      this.R = Math.max(1.2, Math.min(15, s.radius + 0.5));
    }
    this.id = e.id;
    this.group.visible = true;
  }

  get target() {
    return this.id;
  }

  /** Sigue al objeto (también mientras se reproduce o se arrastra) y mantiene el tamaño en pantalla. */
  update(camera: THREE.Camera) {
    if (!this.id) return;
    const obj = this.obj();
    if (!obj || !obj.visible) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;
    this.group.position.set(obj.position.x, obj.position.y + 0.06, obj.position.z);
    const eu = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
    this.group.rotation.set(0, eu.y, 0);
    this.ring.scale.setScalar(this.R);
    this.stem.scale.set(1, 1, this.R);
    const d = camera.position.distanceTo(this.group.position);
    const k = Math.min(3, Math.max(0.35, d * 0.022));
    this.knob.position.set(0, 0, -this.R);
    this.knob.scale.setScalar(k);
    this.hit.position.copy(this.knob.position);
    this.hit.scale.setScalar(k);
  }

  /** Posición de la flecha de giro en el mundo (null si no hay dial). */
  knobWorld(): THREE.Vector3 | null {
    if (!this.id || !this.group.visible) return null;
    this.group.updateMatrixWorld(true);
    return this.knob.getWorldPosition(new THREE.Vector3());
  }

  /** ¿El puntero está sobre la flecha de giro? */
  pick(rc: THREE.Raycaster) {
    if (!this.id || !this.group.visible) return false;
    this.group.updateMatrixWorld(true);
    return rc.intersectObjects([this.hit, this.knob], false).length > 0;
  }
}

/** Rumbos de la carretera más cercana (en ambos sentidos), para ajustar el giro a la vía. */
export function roadHeadings(world: World, x: number, z: number, maxDist = 14): number[] {
  let best: { tx: number; tz: number; d: number } | null = null;
  for (const S of world.samples.values()) {
    for (const q of S) {
      const d = Math.hypot(q.x - x, q.z - z);
      if (d < maxDist && (!best || d < best.d)) best = { tx: q.tx, tz: q.tz, d };
    }
  }
  if (!best) return [];
  const h = ((Math.atan2(best.tx, -best.tz) * 180) / Math.PI + 360) % 360;
  return [h, (h + 180) % 360];
}

const DIRS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];
export const headingText = (h: number) => `${Math.round(((h % 360) + 360) % 360)}° · hacia el ${DIRS[Math.round((((h % 360) + 360) % 360) / 45) % 8]}`;
