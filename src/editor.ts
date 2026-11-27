import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { newId, type Store } from './model/store';
import type { Entity, OverlayEntity, PropEntity } from './model/types';
import type { Viewport } from './scene/viewport';
import type { World } from './scene/world';
import { Handles, type HandleKind } from './tools/handles';
import { DEG } from './scene/utils';
import type { Player } from './anim/player';
import { repositionVehicle, type RepositionResult } from './physics/reposition';
import { toast } from './ui/dom';

export interface ToolEvent {
  e: PointerEvent | MouseEvent;
  ground: THREE.Vector3 | null;
  ray: THREE.Raycaster;
}

export interface Tool {
  id: string;
  label: string;
  icon: string;
  key: string;
  hint: string;
  /** Permite arrastrar tiradores de la selección mientras está activa. */
  handles?: boolean;
  activate?(): void;
  deactivate?(): void;
  /** Devuelve true si captura el arrastre (desactiva la cámara). */
  down?(ev: ToolEvent): boolean;
  move?(ev: ToolEvent): void;
  up?(ev: ToolEvent): void;
  click?(ev: ToolEvent): void;
  dblclick?(ev: ToolEvent): void;
  rightClick?(ev: ToolEvent): void;
  onKey?(e: KeyboardEvent): boolean;
  options?(el: HTMLElement): void;
}

interface HandleDrag {
  kind: HandleKind;
  index: number;
  id: string;
  grab?: THREE.Vector2;
}

export class Editor {
  tools = new Map<string, Tool>();
  tool!: Tool;
  handles: Handles;
  gizmo: TransformControls;
  private selBox: THREE.BoxHelper | null = null;
  cursor: THREE.Vector3 | null = null;
  private downAt: { x: number; y: number; button: number } | null = null;
  private captured = false;
  private handleDrag: HandleDrag | null = null;
  private toolListeners: ((t: Tool) => void)[] = [];
  private cursorListeners: ((p: THREE.Vector3 | null) => void)[] = [];

  constructor(
    public store: Store,
    public vp: Viewport,
    public world: World,
  ) {
    this.handles = new Handles(vp.scene, world);
    this.gizmo = new TransformControls(vp.camera, vp.renderer.domElement);
    this.gizmo.setSize(0.9);
    this.gizmo.showY = false;
    vp.scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (ev) => {
      vp.controls.enabled = !ev.value;
      if (ev.value) {
        this.player?.pause();
        this.vehicleMoved = false;
        store.begin();
      } else {
        // un vehículo recolocado en el instante actual: adaptar la reconstrucción
        const sel = store.selection && store.get(store.selection.id);
        let res: RepositionResult | null = null;
        if (this.vehicleMoved && sel && sel.kind === 'vehicle' && this.gizmo.object) {
          const obj = this.gizmo.object;
          const eu = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
          const pose = { x: obj.position.x, z: obj.position.z, h: ((-eu.y / DEG) % 360 + 360) % 360 };
          res = repositionVehicle(world, sel, this.player?.time ?? 0, pose);
        }
        this.vehicleMoved = false;
        store.end();
        const id = store.selection?.id;
        if (res) store.notify({ type: 'env' });
        else if (id) store.notify({ type: 'entity', id });
        if (res) {
          toast(res.message);
          if (res.needsFit && sel) this.onNeedsFit?.(sel.id);
        }
      }
    });
    this.gizmo.addEventListener('objectChange', () => this.onGizmoChange());

    const dom = vp.dom;
    dom.addEventListener('pointerdown', (e) => this.onDown(e), { capture: true });
    dom.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    dom.addEventListener('dblclick', (e) => this.tool.dblclick?.(this.event(e)));
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e));

    store.onSelect(() => this.refreshSelection());
    world.onRebuilt = () => this.refreshSelection();
    vp.onFrame(() => {
      this.handles.update(vp.camera);
      this.selBox?.update();
    });
  }

  // ---------- herramientas ----------
  register(t: Tool) {
    this.tools.set(t.id, t);
    if (!this.tool) this.tool = t;
  }
  setTool(id: string) {
    const t = this.tools.get(id);
    if (!t || t === this.tool) return;
    this.tool.deactivate?.();
    this.tool = t;
    t.activate?.();
    this.refreshSelection();
    for (const l of this.toolListeners) l(t);
  }
  onToolChange(fn: (t: Tool) => void) {
    this.toolListeners.push(fn);
  }
  onCursor(fn: (p: THREE.Vector3 | null) => void) {
    this.cursorListeners.push(fn);
  }

  // ---------- consulta del suelo ----------
  /** Punto del suelo bajo el puntero: calzadas y agua tienen prioridad sobre el terreno. */
  groundPick(rc: THREE.Raycaster): THREE.Vector3 | null {
    const t = this.world.terrain.raycast(rc.ray);
    const surf = this.store.project.entities
      .filter((e) => (e.kind === 'road' || e.kind === 'river' || e.kind === 'roundabout' || e.kind === 'area') && !e.hidden)
      .map((e) => this.world.objects.get(e.id))
      .filter((o): o is THREE.Object3D => !!o);
    const hit = rc.intersectObjects(surf, true)[0];
    if (hit && (!t || hit.distance <= t.distanceTo(rc.ray.origin) + 0.5)) return hit.point.clone();
    return t;
  }

  event(e: PointerEvent | MouseEvent): ToolEvent {
    const ray = this.vp.raycaster(e);
    return { e, ray, ground: this.groundPick(ray) };
  }

  // ---------- puntero ----------
  private onDown(e: PointerEvent) {
    const tgt = e.target as HTMLElement;
    if (tgt.closest('.labels-layer .label button')) return;
    // la barra de tiempo, la brújula y demás controles superpuestos no son clics en la escena
    if (tgt !== this.vp.renderer.domElement && !tgt.closest('.labels-layer')) return;
    this.downAt = { x: e.clientX, y: e.clientY, button: e.button };
    if (e.button !== 0) return;
    if (this.gizmo.object && this.gizmo.axis) return; // lo gestiona el gizmo
    const ev = this.event(e);
    const sel = this.store.selection;
    if (this.tool.handles && sel) {
      const h = this.handles.pick(ev.ray);
      if (h) {
        this.startHandleDrag(sel.id, h.kind, h.index, ev);
        this.capture();
        return;
      }
    }
    if (this.tool.down?.(ev)) this.capture();
  }

  private capture() {
    this.captured = true;
    this.vp.controls.enabled = false;
  }

  private onMove(e: PointerEvent) {
    const ev = this.event(e);
    this.cursor = ev.ground;
    for (const l of this.cursorListeners) l(ev.ground);
    if (this.handleDrag) this.dragHandle(ev);
    else this.tool.move?.(ev);
  }

  private onUp(e: PointerEvent) {
    const d = this.downAt;
    this.downAt = null;
    const ev = this.event(e);
    if (this.handleDrag) {
      this.handleDrag = null;
      this.store.end();
    } else if (this.captured) this.tool.up?.(ev);
    if (this.captured) {
      this.captured = false;
      this.vp.controls.enabled = true;
    }
    if (!d) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved < 5 && !this.gizmo.dragging) {
      if (d.button === 0 && this.pickOnce && ev.ground) {
        const f = this.pickOnce;
        this.pickOnce = null;
        f(ev.ground);
        return;
      }
      if (d.button === 0) this.tool.click?.(ev);
      else if (d.button === 2) this.tool.rightClick?.(ev);
    }
  }

  // ---------- tiradores ----------
  private startHandleDrag(id: string, kind: HandleKind, index: number, ev: ToolEvent) {
    const e = this.store.get(id);
    if (!e) return;
    this.store.begin();
    if (kind === 'routeMid' && e.kind === 'vehicle' && e.drive) {
      const P = e.drive.path;
      const a = P[index];
      const b = P[index + 1];
      P.splice(index + 1, 0, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, h: null });
      kind = 'route';
      index = index + 1;
      this.store.notify({ type: 'entity', id });
    }
    if (kind === 'mid' && 'points' in e) {
      const a = e.points[index];
      const b = e.points[(index + 1) % e.points.length];
      e.points.splice(index + 1, 0, { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, h: a.h !== null && b.h !== null ? (a.h + b.h) / 2 : null });
      kind = 'point';
      index = index + 1;
      this.store.select({ id, point: index });
      this.store.notify({ type: 'entity', id });
    } else if (kind === 'point' || kind === 'route') {
      this.store.select({ id, point: index });
    }
    const drag: HandleDrag = { kind, index, id };
    if (kind === 'ovCenter' && e.kind === 'overlay' && ev.ground) drag.grab = new THREE.Vector2(e.cx - ev.ground.x, e.cz - ev.ground.z);
    if (kind === 'center' && ev.ground) {
      if (e.kind === 'roundabout') drag.grab = new THREE.Vector2(e.cx - ev.ground.x, e.cz - ev.ground.z);
      if (e.kind === 'photo') drag.grab = new THREE.Vector2(e.x - ev.ground.x, e.z - ev.ground.z);
    }
    this.handleDrag = drag;
  }

  private dragHandle(ev: ToolEvent) {
    const d = this.handleDrag!;
    const e = this.store.get(d.id);
    const g = ev.ground ?? this.planeHit(ev.ray);
    if (!e || !g) return;
    if (d.kind === 'point' && 'points' in e) {
      e.points[d.index].x = g.x;
      e.points[d.index].z = g.z;
    } else if (d.kind === 'route' && e.kind === 'vehicle' && e.drive?.path[d.index]) {
      e.drive.path[d.index].x = g.x;
      e.drive.path[d.index].z = g.z;
    } else if (d.kind === 'impact' && this.store.project.impact) {
      this.store.project.impact.x = g.x;
      this.store.project.impact.z = g.z;
      this.store.notify({ type: 'env' });
      return;
    } else if (d.kind === 'center' && e.kind === 'roundabout') {
      e.cx = g.x + (d.grab?.x ?? 0);
      e.cz = g.z + (d.grab?.y ?? 0);
    } else if (d.kind === 'center' && e.kind === 'photo') {
      e.x = g.x + (d.grab?.x ?? 0);
      e.z = g.z + (d.grab?.y ?? 0);
    } else if (d.kind === 'radius' && e.kind === 'roundabout') {
      e.radius = Math.max(e.width + 1.5, Math.hypot(g.x - e.cx, g.z - e.cz));
    } else if (e.kind === 'overlay') {
      if (d.kind === 'ovCenter') {
        e.cx = g.x + (d.grab?.x ?? 0);
        e.cz = g.z + (d.grab?.y ?? 0);
      } else if (d.kind === 'ovCorner') {
        const lx = d.index === 0 || d.index === 3 ? -1 : 1;
        const lz = d.index < 2 ? -e.aspect : e.aspect;
        const vx = g.x - e.cx;
        const vz = g.z - e.cz;
        const len = Math.hypot(vx, vz);
        e.width = Math.max(1, (2 * len) / Math.hypot(1, e.aspect));
        const shift = (ev.e as PointerEvent).shiftKey;
        if (!shift) e.rot = ((Math.atan2(vz, vx) - Math.atan2(lz, lx)) / DEG + 360) % 360;
      }
    }
    this.store.notify({ type: 'entity', id: d.id });
  }

  /** Intersección con un plano horizontal (fuera del terreno). */
  planeHit(rc: THREE.Raycaster, y = 0) {
    const p = new THREE.Vector3();
    return rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null;
  }

  // ---------- gizmo de objetos ----------
  private onGizmoChange() {
    const sel = this.store.selection;
    const e = sel && this.store.get(sel.id);
    const obj = this.gizmo.object;
    if (!e || !obj) return;
    if (e.kind === 'vehicle') {
      // se mueve el vehículo tal como está en el instante actual; al soltarlo se recalcula
      obj.position.y = this.world.surfaceHeight(obj.position.x, obj.position.z);
      this.vehicleMoved = true;
      return;
    }
    if (e.kind !== 'prop') return;
    e.x = obj.position.x;
    e.z = obj.position.z;
    e.rot = ((-obj.rotation.y / DEG) % 360 + 360) % 360;
    this.world.placeProp(obj, e);
    this.inspectorSync?.();
  }
  inspectorSync: (() => void) | null = null;
  /** Se ha arrastrado el vehículo seleccionado durante el gesto actual del gizmo. */
  private vehicleMoved = false;
  /** Tras recolocar un vehículo después del choque: buscar velocidades que lo reproduzcan. */
  onNeedsFit: ((id: string) => void) | null = null;
  /** Texto de ayuda contextual en la barra de estado. */
  setHint: ((s: string) => void) | null = null;
  /** Vuelve a dibujar el panel de opciones de la herramienta activa. */
  refreshOptions: (() => void) | null = null;
  /** Entra en el modo «coincidir foto» para la foto indicada. */
  photoMatch: ((id: string) => void) | null = null;
  /** Captura el próximo clic sobre el suelo (p. ej. fijar el punto de colisión). */
  pickOnce: ((p: THREE.Vector3) => void) | null = null;
  /** Reproductor de la animación (lo asigna main). */
  player: Player | null = null;
  /** Abre la herramienta de vehículos para cambiar la ficha del vehículo indicado. */
  vehicleChangeSpec: ((id: string) => void) | null = null;

  setGizmoMode(mode: 'translate' | 'rotate') {
    this.gizmo.setMode(mode);
    this.gizmo.showX = mode === 'translate';
    this.gizmo.showZ = mode === 'translate';
    this.gizmo.showY = mode === 'rotate';
  }

  // ---------- selección ----------
  select(id: string | null, point?: number) {
    this.store.select(id ? { id, point } : null);
  }

  refreshSelection() {
    const sel = this.store.selection;
    const e = sel ? this.store.get(sel.id) : undefined;
    if (this.selBox) {
      this.vp.scene.remove(this.selBox);
      this.selBox.geometry.dispose();
      this.selBox = null;
    }
    this.gizmo.detach();
    this.handles.clear();
    this.world.showGhostFor(sel?.id ?? null);
    if (!e) return;
    const obj = this.world.objects.get(e.id);
    if ((e.kind === 'prop' || e.kind === 'linear' || e.kind === 'vehicle') && obj && obj.visible) {
      this.selBox = new THREE.BoxHelper(obj, 0xffb020);
      (this.selBox.material as THREE.LineBasicMaterial).depthTest = false;
      this.selBox.renderOrder = 9;
      this.vp.scene.add(this.selBox);
    }
    const gt = e.kind === 'vehicle' ? this.world.gizmoTarget(e) : obj;
    if ((e.kind === 'prop' || e.kind === 'vehicle') && gt && obj?.visible && (this.tool.id === 'select' || this.tool.id === 'vehicle')) this.gizmo.attach(gt);
    if (this.tool.handles) this.handles.show(e, sel?.point);
  }

  // ---------- acciones ----------
  deleteSelection() {
    const sel = this.store.selection;
    if (!sel) return;
    const e = this.store.get(sel.id);
    if (!e) return;
    if (sel.point !== undefined && e.kind === 'vehicle' && e.drive && e.drive.path.length > 2) {
      this.store.edit(() => e.drive!.path.splice(sel.point!, 1), { type: 'entity', id: e.id });
      this.select(e.id);
      return;
    }
    if (sel.point !== undefined && 'points' in e && e.points.length > (e.kind === 'area' ? 3 : 2)) {
      this.store.edit(() => e.points.splice(sel.point!, 1), { type: 'entity', id: e.id });
      this.select(e.id);
      return;
    }
    this.store.remove(e.id);
  }

  duplicateSelection() {
    const sel = this.store.selection;
    const e = sel && this.store.get(sel.id);
    if (!e) return;
    const c = structuredClone(e) as Entity;
    c.id = newId();
    c.name = e.name + ' (copia)';
    if (c.kind === 'prop' || c.kind === 'vehicle') {
      c.x += c.kind === 'vehicle' ? c.spec.W + 1 : 2;
      c.z += 2;
    } else if ('points' in c) c.points.forEach((p) => ((p.x += 3), (p.z += 3)));
    else if (c.kind === 'roundabout') c.cx += c.radius * 2.5;
    else if (c.kind === 'photo') c.x += 2;
    else if (c.kind === 'overlay') c.cx += 5;
    this.store.add(c);
    this.select(c.id);
  }

  focusSelection() {
    const sel = this.store.selection;
    const e = sel && this.store.get(sel.id);
    if (!e) return;
    const obj = this.world.objects.get(e.id);
    let c: THREE.Vector3;
    let r = 15;
    if (obj) {
      const box = new THREE.Box3().setFromObject(obj);
      const s = new THREE.Sphere();
      box.getBoundingSphere(s);
      c = s.center;
      r = Math.max(6, s.radius * 2.2);
    } else if (e.kind === 'overlay') {
      const o = e as OverlayEntity;
      c = new THREE.Vector3(o.cx, this.world.terrain.height(o.cx, o.cz), o.cz);
      r = o.width;
    } else return;
    this.vp.focus(c, r);
  }

  private onKey(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      this.store.redo();
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      this.duplicateSelection();
      return;
    }
    if (ctrl) return;
    if (this.tool.onKey?.(e)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.deleteSelection();
      return;
    }
    if (e.key === 'Escape') {
      if (this.tool.id !== 'select') this.setTool('select');
      else this.select(null);
      return;
    }
    const k = e.key.toLowerCase();
    if (k === 'f') return this.focusSelection();
    if (k === 'p') return this.vp.topView();
    const sel = this.store.selection && this.store.get(this.store.selection.id);
    if ((sel?.kind === 'prop' || sel?.kind === 'vehicle') && (k === 'g' || k === 'r')) return this.setGizmoMode(k === 'g' ? 'translate' : 'rotate');
    for (const t of this.tools.values()) if (t.key === k) return this.setTool(t.id);
  }
}

export type { PropEntity };
