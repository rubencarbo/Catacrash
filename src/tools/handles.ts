import * as THREE from 'three';
import type { Entity, OverlayEntity } from '../model/types';
import { overlayCorners } from '../scene/overlay';
import type { World } from '../scene/world';
import { Path } from '../physics/path';

export type HandleKind = 'point' | 'mid' | 'ovCenter' | 'ovCorner' | 'center' | 'radius' | 'route' | 'routeMid' | 'impact';

const geoPoint = new THREE.SphereGeometry(1, 16, 12);
const geoMid = new THREE.SphereGeometry(0.6, 12, 8);
geoPoint.userData.shared = true;
geoMid.userData.shared = true;

const matPoint = new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true });
const matSel = new THREE.MeshBasicMaterial({ color: 0xff3d3d, depthTest: false, transparent: true });
const matMid = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.55 });
const matLine = new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true, opacity: 0.9 });

/** Tiradores para editar trazados (puntos de control) y calcos (centro y esquinas). */
export class Handles {
  group = new THREE.Group();
  private items: THREE.Mesh[] = [];
  private line: THREE.Line | null = null;

  constructor(
    scene: THREE.Scene,
    private world: World,
  ) {
    this.group.renderOrder = 10;
    scene.add(this.group);
  }

  clear() {
    for (const m of this.items) this.group.remove(m);
    this.items = [];
    if (this.line) {
      this.group.remove(this.line);
      this.line.geometry.dispose();
      this.line = null;
    }
  }

  private add(kind: HandleKind, index: number, p: THREE.Vector3, selected = false) {
    const mid = kind === 'mid' || kind === 'routeMid';
    const m = new THREE.Mesh(mid ? geoMid : geoPoint, mid ? matMid : selected ? matSel : matPoint);
    m.position.copy(p);
    m.renderOrder = 10;
    m.userData.handle = { kind, index };
    this.items.push(m);
    this.group.add(m);
  }

  private polyline(pts: THREE.Vector3[], closed = false) {
    const g = new THREE.BufferGeometry().setFromPoints(closed ? [...pts, pts[0]] : pts);
    this.line = new THREE.Line(g, matLine);
    this.line.renderOrder = 9;
    this.group.add(this.line);
  }

  show(e: Entity | undefined, selectedPoint?: number) {
    this.clear();
    if (!e || e.hidden) return;
    const t = this.world.terrain;
    if (e.kind === 'road' || e.kind === 'river' || e.kind === 'linear' || e.kind === 'area') {
      const closed = e.kind === 'area';
      const pts = e.points.map((p) => {
        const y = e.kind === 'road' || e.kind === 'area' ? this.world.surfaceHeight(p.x, p.z) : t.height(p.x, p.z);
        return new THREE.Vector3(p.x, y + 0.4, p.z);
      });
      pts.forEach((p, i) => this.add('point', i, p, i === selectedPoint));
      const segs = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segs; i++) {
        const m = pts[i].clone().lerp(pts[(i + 1) % pts.length], 0.5);
        m.y = t.height(m.x, m.z) + 0.4;
        this.add('mid', i, m);
      }
      this.polyline(pts, closed && pts.length > 2);
    } else if (e.kind === 'roundabout') {
      const y = this.world.surfaceHeight(e.cx, e.cz) + 0.6;
      this.add('center', 0, new THREE.Vector3(e.cx, y, e.cz));
      this.add('radius', 0, new THREE.Vector3(e.cx + e.radius, t.height(e.cx + e.radius, e.cz) + 0.5, e.cz));
    } else if (e.kind === 'vehicle' && e.drive && e.drive.path.length > 1 && !e.marks) {
      // ruta prevista del conductor
      const P = e.drive.path;
      const pts = P.map((p) => new THREE.Vector3(p.x, this.world.surfaceHeight(p.x, p.z) + 0.35, p.z));
      pts.forEach((p, i) => this.add('route', i, p, i === selectedPoint));
      for (let i = 0; i < pts.length - 1; i++) {
        const m = pts[i].clone().lerp(pts[i + 1], 0.5);
        this.add('routeMid', i, m);
      }
      const dense = new Path(P);
      const line: THREE.Vector3[] = [];
      for (let s = 0; s <= dense.length; s += 1) {
        const [x, z] = dense.point(s);
        line.push(new THREE.Vector3(x, this.world.surfaceHeight(x, z) + 0.12, z));
      }
      if (line.length > 1) this.polyline(line);
      // punto de colisión (rojo)
      const ip = this.world.impactPoint();
      if (ip) this.add('impact', 0, new THREE.Vector3(ip.x, this.world.surfaceHeight(ip.x, ip.z) + 0.6, ip.z), true);
    } else if (e.kind === 'photo') {
      this.add('center', 0, new THREE.Vector3(e.x, t.height(e.x, e.z) + 0.3, e.z));
    } else if (e.kind === 'overlay') {
      const o = e as OverlayEntity;
      const corners = overlayCorners(o).map(([x, z]) => new THREE.Vector3(x, t.height(x, z) + 0.5, z));
      corners.forEach((p, i) => this.add('ovCorner', i, p));
      this.add('ovCenter', 0, new THREE.Vector3(o.cx, t.height(o.cx, o.cz) + 0.5, o.cz));
      this.polyline(corners, true);
    }
  }

  /** Escala los tiradores para que mantengan su tamaño en pantalla. */
  update(camera: THREE.Camera) {
    for (const m of this.items) {
      const d = camera.position.distanceTo(m.position);
      m.scale.setScalar(Math.max(0.12, d * 0.009));
    }
  }

  pick(rc: THREE.Raycaster): { kind: HandleKind; index: number } | null {
    const hit = rc.intersectObjects(this.items, false)[0];
    return hit ? (hit.object.userData.handle as { kind: HandleKind; index: number }) : null;
  }
}
