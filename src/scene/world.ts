import * as THREE from 'three';
import type { Change, Store } from '../model/store';
import type { AreaEntity, Entity, LinearEntity, OverlayEntity, PropEntity, RiverEntity, RoadEntity, RoundaboutEntity } from '../model/types';
import { areaGeometry, areaShaper, buildArea, type AreaGeom } from './area';
import { roadFootprint, type Footprint } from './footprint';
import { buildPhotoMarker } from './photo';
import { layoutProfile } from './profile';
import { buildRoundabout, rbFootprint, rbShaper } from './roundabout';
import { buildLinear } from './linear';
import { setWet } from './materials';
import { updateOverlays } from './overlay';
import { buildProp, CATALOG } from './props';
import { buildRiver, riverCorridor } from './river';
import { buildRoad, roadCorridor } from './road';
import { samplePath, type PathSample } from './spline';
import { Terrain, type Shaper } from './terrain';
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
  private corridors: Shaper[] = [];
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
    this.vp.setShadowExtent(this.terrain.half + 10);
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
      else if (e.kind === 'road' || e.kind === 'river' || e.kind === 'roundabout' || e.kind === 'area') this.pendingFull = true;
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

  /** Huellas de calzadas (carreteras y glorietas) de la última reconstrucción. */
  footprints: Footprint[] = [];
  /** Cota del centro de cada glorieta. */
  private rbH = new Map<string, number>();

  rebuildAll() {
    const p = this.store.project;
    for (const id of [...this.objects.keys()]) this.clearObject(id);
    this.samples.clear();
    this.rbH.clear();
    const t = this.terrain;

    const rivers = p.entities.filter((e): e is RiverEntity => e.kind === 'river');
    const roads = p.entities.filter((e): e is RoadEntity => e.kind === 'road');
    const rbs = p.entities.filter((e): e is RoundaboutEntity => e.kind === 'roundabout');
    const areas = p.entities.filter((e): e is AreaEntity => e.kind === 'area');

    // 1) Rango de cada calzada: las glorietas mandan; luego por prioridad y orden.
    const ordered: { e: RoadEntity | RoundaboutEntity; rank: number }[] = [
      ...rbs.map((e, i) => ({ e, rank: 10000 + i })),
      ...roads.map((e, i) => ({ e, rank: (e.priority ?? 1) * 1000 + i })),
    ].sort((x, y) => y.rank - x.rank);

    // 2) Trazados y huellas de mayor a menor rango; los extremos que caen dentro
    //    de una calzada superior toman su cota (enlace de cruces).
    const fps: Footprint[] = [];
    const fpHeight = (x: number, z: number, above = -Infinity) => {
      for (const f of fps) if (f.rank > above && f.inside(x, z, 0.3)) return f.height(x, z);
      return null;
    };
    const rankOf = new Map<string, number>();
    for (const { e, rank } of ordered) {
      rankOf.set(e.id, rank);
      if (e.kind === 'roundabout') {
        const H = e.h ?? fpHeight(e.cx, e.cz, rank) ?? t.baseHeight(e.cx, e.cz);
        this.rbH.set(e.id, H);
        fps.push(rbFootprint(e, H, rank));
      } else {
        const S = samplePath(e.points, (pt) => pt.h ?? fpHeight(pt.x, pt.z, rank) ?? t.baseHeight(pt.x, pt.z), 0.5, true);
        this.samples.set(e.id, S);
        if (S.length > 1) fps.push(roadFootprint(e.id, rank, S, layoutProfile(e.profile)));
      }
    }
    this.footprints = fps;

    // 3) Explanación: ríos, calzadas de menor a mayor rango y, al final, áreas.
    const shapers: Shaper[] = [];
    for (const r of rivers) {
      const S = samplePath(r.points, (pt) => pt.h ?? t.baseHeight(pt.x, pt.z) + r.levelOffset, 1, true);
      this.samples.set(r.id, S);
      shapers.push(riverCorridor(r, S));
    }
    for (const { e } of [...ordered].reverse()) {
      if (e.kind === 'roundabout') shapers.push(rbShaper(e, this.rbH.get(e.id)!));
      else shapers.push(roadCorridor(e, this.samples.get(e.id)!));
    }
    const areaGeo = new Map<string, AreaGeom>();
    for (const a of areas) {
      const g = areaGeometry(a.points, (pt) => pt.h ?? fpHeight(pt.x, pt.z) ?? t.baseHeight(pt.x, pt.z));
      areaGeo.set(a.id, g);
      shapers.push(areaShaper(a, g));
    }
    this.corridors = shapers;
    t.rebuild(shapers);

    // 4) Mallas
    const overlap = (f: Footprint, g: Footprint) => f.minX <= g.maxX && f.maxX >= g.minX && f.minZ <= g.maxZ && f.maxZ >= g.minZ;
    for (const r of rivers) this.addObject(r, buildRiver(r, this.samples.get(r.id)!));
    for (const { e, rank } of ordered) {
      const me = fps.find((f) => f.id === e.id);
      const near = me ? fps.filter((f) => f !== me && overlap(f, me)) : [];
      const above = near.filter((f) => f.rank > rank);
      const below = near.filter((f) => f.rank < rank);
      if (e.kind === 'roundabout') this.addObject(e, buildRoundabout(e, this.rbH.get(e.id)!, below));
      else this.addObject(e, buildRoad(e, this.samples.get(e.id)!, { above, below, terrainH: (x, z) => t.height(x, z) }));
    }
    for (const a of areas) this.addObject(a, buildArea(a, areaGeo.get(a.id)!));
    this.root.updateMatrixWorld(true);
    for (const e of p.entities) {
      if (e.kind === 'linear' || e.kind === 'prop' || e.kind === 'photo') this.rebuildEntity(e.id);
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
      case 'photo':
        this.addObject(e, buildPhotoMarker(e, this.terrain.height(e.x, e.z)));
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
      .filter((e) => e.kind === 'road' || e.kind === 'roundabout' || e.kind === 'area')
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
