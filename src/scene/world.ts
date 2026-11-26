import * as THREE from 'three';
import type { Change, Store } from '../model/store';
import type { AreaEntity, Entity, LinearEntity, OverlayEntity, PropEntity, RiverEntity, RoadEntity, RoundaboutEntity, VehicleEntity } from '../model/types';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildVehicle } from './vehicle3d';
import { buildMotion, type Motion } from '../anim/motion';
import { buildSkids, type Skids } from '../anim/skids';
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
    const sk = this.skids.get(id);
    if (sk) {
      this.root.remove(sk.group);
      sk.group.traverse((c) => (c as THREE.Mesh).geometry?.dispose());
      this.skids.delete(id);
    }
    const o = this.objects.get(id);
    if (o) {
      this.root.remove(o);
      o.traverse((c) => {
        if (c instanceof CSS2DObject) c.element.remove();
      });
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
      if (e.kind === 'linear' || e.kind === 'prop' || e.kind === 'photo' || e.kind === 'vehicle') this.rebuildEntity(e.id);
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
      case 'vehicle':
        this.invalidateMotion(e.id);
        this.addObject(e, this.makeVehicle(e));
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

  /** Instante actual de la animación (0 = impacto). */
  time = 0;
  private motions = new Map<string, Motion | null>();
  private skids = new Map<string, Skids>();

  motionOf(e: VehicleEntity): Motion | null {
    if (!this.motions.has(e.id)) this.motions.set(e.id, (e.motion?.length ?? 0) > 0 ? buildMotion(e) : null);
    return this.motions.get(e.id)!;
  }
  invalidateMotion(id: string) {
    this.motions.delete(id);
  }

  private makeVehicle(e: VehicleEntity) {
    const wrap = new THREE.Group();
    wrap.rotation.order = 'YXZ';
    const damaged = buildVehicle(e);
    damaged.userData.state = 'damaged';
    wrap.add(damaged);
    if (e.damage.length && (e.motion?.length ?? 0) > 1) {
      const intact = buildVehicle({ ...e, damage: [] });
      intact.userData.state = 'intact';
      wrap.add(intact);
    }
    const div = document.createElement('div');
    div.className = 'label vehicle';
    div.textContent = e.label || e.name;
    div.style.setProperty('--chip', e.color);
    const lbl = new CSS2DObject(div);
    lbl.position.set(0, e.spec.H + 0.9, 0);
    lbl.userData.isLabel = true;
    wrap.add(lbl);
    // Huellas de neumáticos de los tramos marcados
    const m = this.motionOf(e);
    const old = this.skids.get(e.id);
    if (old) {
      this.root.remove(old.group);
      this.skids.delete(e.id);
    }
    if (m) {
      const sk = buildSkids(e, m, (x, z) => this.surfaceHeight(x, z));
      if (sk) {
        sk.group.userData.skidOf = e.id;
        this.root.add(sk.group);
        this.skids.set(e.id, sk);
        sk.update(this.time);
      }
    }
    this.placeVehicle(wrap, e);
    return wrap;
  }

  /** Pose del vehículo en el instante actual (trayectoria o posición estática). */
  vehiclePose(e: VehicleEntity) {
    const m = this.motionOf(e);
    if (m) return m.pose(this.time);
    return { x: e.x, z: e.z, heading: e.heading, speed: 0, seg: 0, marks: false };
  }

  /** Coloca el vehículo sobre el firme, inclinado según la pendiente bajo sus ruedas. */
  placeVehicle(obj: THREE.Object3D, e: VehicleEntity) {
    const sp = e.spec;
    const pose = this.vehiclePose(e);
    const a = (-pose.heading * Math.PI) / 180;
    const hd = (pose.heading * Math.PI) / 180;
    const fwd = new THREE.Vector3(Math.sin(hd), 0, -Math.cos(hd)); // dirección del frontal
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const at = (f: number, r: number) => this.surfaceHeight(pose.x + fwd.x * f + right.x * r, pose.z + fwd.z * f + right.z * r);
    const hf = Math.max(0.3, sp.L / 2 - sp.volD);
    const hr = Math.max(0.3, sp.L / 2 - sp.volT);
    const hw = Math.max(0.15, (sp.viaD || sp.W * 0.8) / 2);
    const yF = at(hf, 0);
    const yR = at(-hr, 0);
    const yL = at((hf - hr) / 2, -hw);
    const yRt = at((hf - hr) / 2, hw);
    const y0 = (yF + yR + yL + yRt) / 4;
    obj.position.set(pose.x, y0, pose.z);
    const pitch = sp.tipo === 'peaton' ? 0 : Math.atan2(yF - yR, hf + hr);
    const roll = sp.tipo === 'peaton' ? 0 : Math.atan2(yRt - yL, 2 * hw);
    obj.rotation.set(pitch, a, roll, 'YXZ');
    // Daños visibles a partir del impacto (los vehículos estáticos se muestran ya dañados)
    const showDamaged = !(e.motion && e.motion.length > 1) || this.time >= 0;
    for (const c of obj.children) {
      if (c.userData.state === 'intact') c.visible = !showDamaged;
      if (c.userData.state === 'damaged') c.visible = showDamaged || !obj.children.some((x) => x.userData.state === 'intact');
    }
  }

  /** Mueve los vehículos animados al instante t. */
  setTime(t: number) {
    this.time = t;
    for (const e of this.store.project.entities) {
      if (e.kind !== 'vehicle') continue;
      const obj = this.objects.get(e.id);
      if (obj && (e.motion?.length ?? 0) > 0) this.placeVehicle(obj, e);
      this.skids.get(e.id)?.update(t);
    }
    this.onTime?.();
  }
  onTime: (() => void) | null = null;

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

  /** Cota de la superficie transitable (calzada, glorieta o área si la hay; si no, terreno). */
  surfaceHeight(x: number, z: number) {
    // Calzadas: cálculo analítico con sus huellas (rápido, apto para animación)
    for (const f of this.footprints) {
      if (f.inside(x, z)) {
        const e = this.store.get(f.id);
        const lift = e && e.kind === 'road' ? (e.priority ?? 1) * 0.004 : 0.012;
        return f.height(x, z) + lift;
      }
    }
    const areas = this.store.project.entities
      .filter((e) => e.kind === 'area')
      .map((e) => this.objects.get(e.id))
      .filter((o): o is THREE.Object3D => !!o);
    if (areas.length) {
      const rc = new THREE.Raycaster(new THREE.Vector3(x, 5000, z), new THREE.Vector3(0, -1, 0), 0, 10000);
      const hit = rc.intersectObjects(areas, true)[0];
      if (hit) return hit.point.y;
    }
    return this.terrain.height(x, z);
  }

  /** Objetos seleccionables con un clic. */
  pickables(): THREE.Object3D[] {
    return [...this.objects.values()].filter((o) => o.visible);
  }
}
