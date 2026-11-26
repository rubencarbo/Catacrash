import * as THREE from 'three';
import type { Store } from '../model/store';
import type { VehicleEntity } from '../model/types';
import type { Viewport } from '../scene/viewport';
import type { World } from '../scene/world';

export type CameraMode = 'libre' | 'seguir' | 'conductor';

/** Reproductor de la animación: tiempo actual, reproducción y cámaras. */
export class Player {
  time = 0;
  playing = false;
  rate = 1;
  camera: CameraMode = 'libre';
  private listeners: (() => void)[] = [];
  private lastFollow: THREE.Vector3 | null = null;
  /** Fin de reproducción (para la grabación de vídeo). */
  onEnd: (() => void) | null = null;

  constructor(
    private store: Store,
    private world: World,
    private vp: Viewport,
  ) {
    vp.onFrame((dt) => this.frame(dt));
  }

  on(fn: () => void) {
    this.listeners.push(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  /** Rango de la animación (0 = impacto). */
  range(): { start: number; end: number } {
    return this.store.project.timeline ?? { start: -4, end: 4 };
  }

  setTime(t: number) {
    const { start, end } = this.range();
    this.time = Math.min(end, Math.max(start, t));
    this.world.setTime(this.time);
    this.emit();
  }

  play() {
    const { start, end } = this.range();
    if (this.time >= end - 1e-3) this.setTime(start);
    this.playing = true;
    this.emit();
  }
  pause() {
    this.playing = false;
    this.emit();
  }
  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  setCamera(mode: CameraMode) {
    this.camera = mode;
    this.lastFollow = null;
    this.vp.controls.enabled = mode !== 'conductor';
    this.emit();
  }

  /** Vehículo al que siguen las cámaras: el seleccionado o, si no, el primero animado. */
  private target(): VehicleEntity | null {
    const sel = this.store.selection && this.store.get(this.store.selection.id);
    if (sel && sel.kind === 'vehicle') return sel;
    return (this.store.project.entities.find((e) => e.kind === 'vehicle' && !!e.drive) as VehicleEntity) ?? null;
  }

  private frame(dt: number) {
    if (this.playing) {
      const { end } = this.range();
      let t = this.time + dt * this.rate;
      if (t >= end) {
        t = end;
        this.playing = false;
        this.onEnd?.();
      }
      this.setTime(t);
    }
    if (this.camera === 'libre') return;
    const v = this.target();
    const obj = v && this.world.objects.get(v.id);
    if (!v || !obj) return;
    if (this.camera === 'seguir') {
      const p = obj.position.clone().add(new THREE.Vector3(0, 1, 0));
      if (this.lastFollow) {
        const d = p.clone().sub(this.lastFollow);
        this.vp.camera.position.add(d);
        this.vp.controls.target.add(d);
      } else {
        this.vp.controls.target.copy(p);
        const back = new THREE.Vector3(0, 0, 1).applyQuaternion(obj.quaternion).setY(0).normalize();
        this.vp.camera.position.copy(p).add(back.multiplyScalar(v.spec.L * 2.2 + 6)).add(new THREE.Vector3(0, 3.5, 0));
      }
      this.lastFollow = p;
    } else {
      // Ojos del conductor (volante a la izquierda)
      const sp = v.spec;
      const eye = new THREE.Vector3(-sp.W * 0.2, sp.tipo === 'peaton' ? sp.H * 0.94 : sp.H * 0.8, -sp.L / 2 + sp.volD + sp.batalla * 0.42);
      if (sp.tipo === 'moto' || sp.tipo === 'ciclomotor' || sp.tipo === 'bicicleta' || sp.tipo === 'patinete') eye.set(0, sp.H + 0.45, 0);
      obj.updateMatrixWorld(true);
      const pos = eye.clone().applyMatrix4(obj.matrixWorld);
      const ahead = new THREE.Vector3(eye.x, eye.y - 0.4, eye.z - 25).applyMatrix4(obj.matrixWorld);
      this.vp.camera.position.copy(pos);
      this.vp.camera.lookAt(ahead);
      this.vp.controls.target.copy(ahead);
    }
  }
}
