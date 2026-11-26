import * as THREE from 'three';
import type { Change, Store } from '../model/store';
import type { Entity, LinearEntity, OverlayEntity, PropEntity, RiverEntity, RoadEntity } from '../model/types';
import { buildLinear } from './linear';
import { setWet } from './materials';
import { updateOverlays } from './overlay';
import { buildProp, CATALOG } from './props';
import { buildRiver, riverCorridor } from './river';
import { buildRoad, roadCorridor } from './road';
import { samplePath, type PathSample } from './spline';
import { Terrain, type Corridor } from './terrain';
import { hashString } from './utils';
import type { Viewport } from './viewport';
import { MAT } from './materials';

/**
 * Sincroniza el modelo (Store) con la escena three.js.
 * Carreteras y ríos modifican el terreno, así que cualquier cambio en ellos
 * reconstruye el terreno y todo lo que se apoya en él.
 */
export class World {
  terrain!: Terrain;
  root = new THREE.Group();
  objects = new Map<string, THREE.Object3D>();
  samples = new Map<string, PathSample[]>();
  private corridors: Corridor[] = [];
  private pendingFull = false;
  private pendingIds = new Set<string>();
  private rafScheduled = false;
  onRebuilt: (() => void) | null = null;

  constructor(
    private store: Store,
    private vp: Viewport,
  ) {
    vp.scene.add(this.root);
    this.createTerrain();
    this.rebuildAll();
    store.on((c) => this.onChange(c));
    vp.onFrame((dt) => {
      const n = MAT.water.normalMap;
      if (n) n.offset.x += dt * 0.02;
    });
  }

  private createTerrain() {
    if (this.terrain) {
      this.vp.scene.remove(this.terrain.mesh);
      this.terrain.dispose();
    }
    this.terrain = new Terrain(this.store.project.terrain);
    this.vp.scene.add(this.terrain.mesh);
  }

  private onChange(c: Change) {
    const p = this.store.project;
    if (c.type === 'all') {
      if (this.terrain.base !== p.terrain.base || this.terrain.size !== p.terrain.size) this.createTerrain();
      this.pendingFull = true;
    } else if (c.type === 'terrain' || c.type === 'entities') {
      if (this.terrain.base !== p.terrain.base) this.createTerrain();
      this.pendingFull = true;
    } else if (c.type === 'env') {
      this.applyEnv();
      return;
    } else if (c.type === 'entity') {
      const e = this.store.get(c.id);
      if (!e) this.pendingFull = true;
      else if (e.kind === 'road' || e.kind === 'river') this.pendingFull = true;
      else this.pendingIds.add(c.id);
    }
    this.schedule();
  }

  private schedule() {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      if (this.pendingFull) this.rebuildAll();
      else for (const id of this.pendingIds) this.rebuildEntity(id);
      this.pendingFull = false;
      this.pendingIds.clear();
      this.onRebuilt?.();
    });
  }

  /** Fuerza una reconstrucción inmediata (p. ej. tras modelar el terreno). */
  rebuildNow() {
    this.rebuildAll();
    this.onRebuilt?.();
  }

  /** Actualiza solo la malla del terreno (durante el modelado con pincel). */
  previewTerrain() {
    this.terrain.rebuild(this.corridors);
  }

  applyEnv() {
    const p = this.store.project;
    this.vp.setEnvironment(p.env, p.geo);
    setWet(p.env.wet);
  }

  private clearObject(id: string) {
    const o = this.objects.get(id);
    if (o) {
      this.root.remove(o);
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
      });
      this.objects.delete(id);
    }
  }

  rebuildAll() {
    const p = this.store.project;
    for (const id of [...this.objects.keys()]) this.clearObject(id);
    this.samples.clear();

    // 1) trazados de carreteras y ríos sobre el terreno natural
    const corridors: Corridor[] = [];
    const rivers = p.entities.filter((e): e is RiverEntity => e.kind === 'river');
    const roads = p.entities.filter((e): e is RoadEntity => e.kind === 'road');
    for (const r of rivers) {
      const S = samplePath(r.points, (pt) => pt.h ?? this.terrain.baseHeight(pt.x, pt.z) + r.levelOffset, 1, true);
      this.samples.set(r.id, S);
      corridors.push(riverCorridor(r, S));
    }
    for (const r of roads) {
      const S = samplePath(r.points, (pt) => pt.h ?? this.terrain.baseHeight(pt.x, pt.z), 0.5, true);
      this.samples.set(r.id, S);
      corridors.push(roadCorridor(r, S));
    }
    // 2) explanación del terreno
    this.corridors = corridors;
    this.terrain.rebuild(corridors);
    // 3) mallas
    for (const r of rivers) this.addObject(r, buildRiver(r, this.samples.get(r.id)!));
    for (const r of roads) this.addObject(r, buildRoad(r, this.samples.get(r.id)!));
    this.root.updateMatrixWorld(true);
    for (const e of p.entities) {
      if (e.kind === 'linear' || e.kind === 'prop') this.rebuildEntity(e.id);
    }
    this.refreshOverlays();
    this.applyEnv();
  }

  rebuildEntity(id: string) {
    const e = this.store.get(id);
    this.clearObject(id);
    if (!e) return;
    switch (e.kind) {
      case 'linear':
        this.addObject(e, buildLinear(e as LinearEntity, this.terrain));
        break;
      case 'prop':
        this.addObject(e, this.makeProp(e));
        break;
      case 'overlay':
        this.refreshOverlays();
        break;
      default:
        this.pendingFull = true;
        this.schedule();
    }
  }

  private makeProp(e: PropEntity) {
    const o = buildProp(e.type, e.params, hashString(e.id));
    const wrap = new THREE.Group();
    wrap.add(o);
    this.placeProp(wrap, e);
    return wrap;
  }

  /** Coloca un objeto en el modelo según la posición/rotación de la entidad. */
  placeProp(obj: THREE.Object3D, e: PropEntity) {
    const onSurface = CATALOG[e.type]?.onSurface;
    const y = onSurface ? this.surfaceHeight(e.x, e.z) : this.terrain.height(e.x, e.z);
    obj.position.set(e.x, y + e.dy, e.z);
    obj.rotation.set(0, (-e.rot * Math.PI) / 180, 0);
  }

  private addObject(e: Entity, o: THREE.Object3D) {
    o.userData.entityId = e.id;
    o.traverse((c) => (c.userData.entityId = e.id));
    o.visible = !e.hidden;
    this.root.add(o);
    this.objects.set(e.id, o);
  }

  refreshOverlays() {
    const list = this.store.project.entities.filter((e): e is OverlayEntity => e.kind === 'overlay');
    updateOverlays(list, this.store.assets);
  }

  /** Cota de la superficie transitable (calzada si la hay, si no terreno). */
  surfaceHeight(x: number, z: number) {
    const rc = new THREE.Raycaster(new THREE.Vector3(x, 5000, z), new THREE.Vector3(0, -1, 0), 0, 10000);
    const roads = this.store.project.entities
      .filter((e) => e.kind === 'road')
      .map((e) => this.objects.get(e.id))
      .filter((o): o is THREE.Object3D => !!o);
    const hit = rc.intersectObjects(roads, true)[0];
    return hit ? hit.point.y : this.terrain.height(x, z);
  }

  /** Objetos seleccionables con un clic. */
  pickables(): THREE.Object3D[] {
    return [...this.objects.values()].filter((o) => o.visible);
  }
}
