import * as THREE from 'three';
import type { Change, Store } from '../model/store';
import type { AreaEntity, Entity, LinearEntity, OverlayEntity, PropEntity, RiverEntity, RoadEntity, RoundaboutEntity, VehicleEntity } from '../model/types';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildVehicle } from './vehicle3d';
import { buildSkids, type Skids } from '../anim/skids';
import { frameAt, simulate, type Frame, type Obstacle, type SimInput, type SimResult, type SurfaceKind } from '../physics/sim';
import { SurfaceCache } from '../physics/surfaceCache';
import { linearSamples } from './linear';
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
  private pendingSim = false;
  private pendingIds = new Set<string>();
  private rafScheduled = false;
  onRebuilt: (() => void) | null = null;

  constructor(
    readonly store: Store,
    readonly vp: Viewport,
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
      // el firme mojado cambia la adherencia; el punto de colisión o el rango de tiempo, la simulación
      this.pendingSim = true;
    } else if (c.type === 'entity') {
      const e = this.store.get(c.id);
      if (!e) this.pendingFull = true;
      else if (e.kind === 'road' || e.kind === 'river' || e.kind === 'roundabout' || e.kind === 'area') this.pendingFull = true;
      else {
        this.pendingIds.add(c.id);
        if (e.kind === 'vehicle' || e.kind === 'linear' || e.kind === 'prop') this.pendingSim = true;
      }
    }
    this.schedule();
  }

  private schedule() {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      if (this.pendingFull) this.rebuildAll();
      else {
        for (const id of this.pendingIds) this.rebuildEntity(id);
        if (this.pendingSim) this.runSim();
      }
      this.pendingSim = false;
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
    const gh = this.ghosts.get(id);
    if (gh) {
      this.root.remove(gh);
      this.ghosts.delete(id);
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
    this.surf = null;
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
    this.runSim();
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
  /** Resultado de la última simulación física. */
  sim: SimResult | null = null;
  private skids = new Map<string, Skids>();
  private ghosts = new Map<string, THREE.Object3D>();
  private impactMarker: THREE.Object3D | null = null;
  /** Se llama tras cada simulación (para refrescar paneles). */
  onSim: (() => void) | null = null;

  impactPoint() {
    return this.store.project.impact ?? null;
  }

  /** Vehículo con conducción simulada. */
  isDriven(e: VehicleEntity) {
    return !!e.drive && e.drive.path.length > 1;
  }

  /** Obstáculos fijos para la simulación: muros, biondas, barreras, vallas, árboles, postes, edificios… */
  obstacles(): Obstacle[] {
    const out: Obstacle[] = [];
    const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
    for (const e of this.store.project.entities) {
      if (e.hidden) continue;
      if (e.kind === 'linear') {
        const P = e.params;
        let hw = 0;
        let k = 0;
        switch (e.type) {
          case 'muro':
            hw = num(P.grosor, 0.4) / 2;
            k = Infinity;
            break;
          case 'barrera_hormigon':
            hw = 0.3;
            k = Infinity;
            break;
          case 'guardarrail':
            hw = 0.15;
            k = 4e5;
            break;
          case 'valla':
            hw = 0.06;
            k = P.tipo === 'madera' ? 1.2e5 : 6e4;
            break;
          case 'seto':
            hw = num(P.ancho, 0.8) / 2;
            k = 3e4;
            break;
          case 'tendido': {
            for (const [i, pt] of e.points.entries()) out.push({ id: `${e.id}:${i}`, name: 'Poste del tendido', cx: pt.x, cz: pt.z, hl: 0.13, hw: 0.13, ang: 0, k: P.poste === 'madera' ? 8e5 : 2e6, kind: 'poste' });
            continue;
          }
          default:
            continue;
        }
        const S = linearSamples(e, this.terrain, 2);
        for (let i = 0; i < S.length - 1; i++) {
          const a = S[i];
          const b = S[i + 1];
          const len = Math.hypot(b.x - a.x, b.z - a.z);
          if (len < 0.05) continue;
          out.push({ id: `${e.id}:${i}`, name: e.name, cx: (a.x + b.x) / 2, cz: (a.z + b.z) / 2, hl: len / 2 + 0.02, hw, ang: Math.atan2(b.z - a.z, b.x - a.x), k, kind: e.type });
        }
      } else if (e.kind === 'prop') {
        const P = { ...(CATALOG[e.type]?.defaults ?? {}), ...e.params };
        const ang = (e.rot * Math.PI) / 180;
        const box = (hl: number, hw: number, k: number, kind: string) => out.push({ id: e.id, name: e.name, cx: e.x, cz: e.z, hl, hw, ang, k, kind });
        switch (e.type) {
          case 'arbol': {
            if (P.especie === 'arbusto' || num(P.altura, 8) < 1.5) break;
            const d = num(P.tronco, 0.35);
            box(d / 2, d / 2, d > 0.25 ? 3e6 : 6e5, 'arbol');
            break;
          }
          case 'farola':
          case 'poste':
          case 'semaforo':
            box(0.1, 0.1, 1.2e6, 'poste');
            break;
          case 'senal':
          case 'cartel':
            box(0.05, 0.05, 8e4, 'poste');
            break;
          case 'bolardo':
            box(num(P.diametro, 0.12) / 2 + 0.02, num(P.diametro, 0.12) / 2 + 0.02, P.tipo === 'flexible' ? 2e4 : 1.5e6, 'poste');
            break;
          case 'edificio':
          case 'caseta':
            box(num(P.ancho, 6) / 2, num(P.fondo, 6) / 2, Infinity, 'muro');
            break;
          case 'contenedor':
            box(0.9, 0.55, 3e5, 'contenedor');
            break;
          case 'jardinera':
            box(num(P.largo, 1.5) / 2, 0.4, 1e6, 'muro');
            break;
          case 'marquesina':
            box(num(P.largo, 4) / 2, 0.9, 2e5, 'contenedor');
            break;
          case 'roca':
            box(num(P.tamano, 1.2) / 2, num(P.tamano, 1.2) / 2, Infinity, 'muro');
            break;
        }
      }
    }
    return out;
  }

  /** Tipo de firme bajo un punto (para la adherencia de cada rueda). */
  surfaceKind(x: number, z: number): SurfaceKind {
    for (const f of this.footprints) if (f.inside(x, z)) return 'asfalto';
    for (const e of this.store.project.entities) {
      if (e.kind !== 'area' || e.points.length < 3) continue;
      let inside = false;
      const R = e.points;
      for (let i = 0, j = R.length - 1; i < R.length; j = i++) {
        if (R[i].z > z !== R[j].z > z && x < ((R[j].x - R[i].x) * (z - R[i].z)) / (R[j].z - R[i].z) + R[i].x) inside = !inside;
      }
      if (!inside) continue;
      return e.material === 'hierba' ? 'hierba' : e.material === 'tierra' || e.material === 'grava' ? 'tierra' : 'asfalto';
    }
    return 'hierba';
  }

  /** Ejecuta la simulación física de todos los vehículos y actualiza sus mallas. */
  /** Caché de suelo para la simulación (se descarta al reconstruir el escenario). */
  private surf: SurfaceCache | null = null;

  /** Datos de entrada de la simulación para el estado actual del proyecto. */
  simInput(vehicles?: VehicleEntity[]): SimInput {
    const p = this.store.project;
    const range = p.timeline ?? { start: -4, end: 4 };
    if (!this.surf)
      this.surf = new SurfaceCache(
        (x, z) => this.surfaceHeight(x, z),
        (x, z) => this.surfaceKind(x, z),
      );
    return {
      vehicles: vehicles ?? p.entities.filter((e): e is VehicleEntity => e.kind === 'vehicle'),
      start: range.start,
      end: range.end,
      impact: p.impact ?? null,
      wet: p.env.wet,
      surfaceH: this.surf.height,
      surfaceKind: this.surf.kind,
      obstacles: this.obstacles(),
    };
  }

  runSim() {
    const p = this.store.project;
    const vehicles = p.entities.filter((e): e is VehicleEntity => e.kind === 'vehicle');
    if (!vehicles.some((v) => this.isDriven(v))) {
      this.sim = null;
    } else {
      this.sim = simulate(this.simInput(vehicles));
    }
    for (const v of vehicles) {
      this.clearObject(v.id);
      this.addObject(v, this.makeVehicle(v));
    }
    this.updateImpactMarker();
    this.setTime(this.time);
    this.onSim?.();
  }

  /** Zonas dañadas a mostrar: las indicadas a mano más las calculadas por la simulación. */
  damageOf(e: VehicleEntity) {
    return [...e.damage, ...(this.sim?.vehicles.get(e.id)?.autoDamage ?? [])];
  }

  private makeVehicle(e: VehicleEntity) {
    const wrap = new THREE.Group();
    wrap.rotation.order = 'YXZ';
    const dmg = this.damageOf(e);
    const sv = this.sim?.vehicles.get(e.id);
    const damaged = buildVehicle({ ...e, damage: dmg });
    damaged.userData.state = 'damaged';
    wrap.add(damaged);
    if (dmg.length && sv && sv.firstContact !== null) {
      const intact = buildVehicle({ ...e, damage: [] });
      intact.userData.state = 'intact';
      wrap.add(intact);
    }
    for (const g of wrap.children)
      g.traverse((c) => {
        if (c.userData.wheel) c.userData.baseRotY = c.rotation.y;
      });
    const div = document.createElement('div');
    div.className = 'label vehicle';
    div.textContent = e.label || e.name;
    div.style.setProperty('--chip', e.color);
    const lbl = new CSS2DObject(div);
    lbl.position.set(0, e.spec.H + 0.9, 0);
    lbl.userData.isLabel = true;
    wrap.add(lbl);
    // Huellas reales de la simulación
    const old = this.skids.get(e.id);
    if (old) {
      this.root.remove(old.group);
      this.skids.delete(e.id);
    }
    if (sv) {
      const sk = buildSkids(sv.marks, (x, z) => this.surfaceHeight(x, z));
      if (sk) {
        sk.group.userData.skidOf = e.id;
        this.root.add(sk.group);
        this.skids.set(e.id, sk);
        sk.update(this.time);
      }
    }
    // Posición final observada (croquis), para comparar con el reposo simulado
    const oldG = this.ghosts.get(e.id);
    if (oldG) this.root.remove(oldG);
    this.ghosts.delete(e.id);
    if (this.isDriven(e) && e.drive!.showFinal) {
      const gh = this.makeGhost(e);
      gh.visible = this.store.selection?.id === e.id;
      this.root.add(gh);
      this.ghosts.set(e.id, gh);
    }
    this.placeVehicle(wrap, e);
    return wrap;
  }

  private makeGhost(e: VehicleEntity) {
    const sp = e.spec;
    const g = new THREE.Group();
    const box = new THREE.BoxGeometry(sp.W, sp.H * 0.9, sp.L);
    box.translate(0, (sp.H * 0.9) / 2, 0);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineDashedMaterial({ color: e.color, dashSize: 0.25, gapSize: 0.15, depthTest: false, transparent: true, opacity: 0.9 }));
    edges.computeLineDistances();
    edges.renderOrder = 8;
    const fill = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: e.color, transparent: true, opacity: 0.12, depthWrite: false }));
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 3).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: e.color, depthTest: false }));
    nose.position.set(0, sp.H * 0.95, -sp.L / 2 + 0.3);
    g.add(edges, fill, nose);
    g.userData.ghostOf = e.id;
    g.traverse((c) => (c.userData.entityId = e.id));
    this.placeGhost(g, e);
    return g;
  }

  /** Solo se ve el contorno de la posición final del vehículo seleccionado. */
  showGhostFor(id: string | null) {
    for (const [gid, g] of this.ghosts) g.visible = gid === id;
  }

  placeGhost(g: THREE.Object3D, e: VehicleEntity) {
    g.position.set(e.x, this.surfaceHeight(e.x, e.z), e.z);
    g.rotation.set(0, (-e.heading * Math.PI) / 180, 0);
  }

  /** Objeto al que se engancha el gizmo: el fantasma de la posición final si está conducido. */
  gizmoTarget(e: VehicleEntity): THREE.Object3D | undefined {
    if (this.isDriven(e)) return this.ghosts.get(e.id);
    return this.objects.get(e.id);
  }

  private updateImpactMarker() {
    if (this.impactMarker) this.root.remove(this.impactMarker);
    this.impactMarker = null;
    const ip = this.store.project.impact;
    if (!ip) return;
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0xef5350, depthTest: false, transparent: true, opacity: 0.9 });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.7, 32).rotateX(-Math.PI / 2), mat);
    const b1 = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.12).rotateX(-Math.PI / 2).rotateY(Math.PI / 4), mat);
    const b2 = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.12).rotateX(-Math.PI / 2).rotateY(-Math.PI / 4), mat);
    for (const m of [ring, b1, b2]) m.renderOrder = 9;
    g.add(ring, b1, b2);
    g.position.set(ip.x, this.surfaceHeight(ip.x, ip.z) + 0.05, ip.z);
    this.impactMarker = g;
    this.root.add(g);
  }

  /** Estado del vehículo en el instante actual (simulación o posición estática). */
  vehiclePose(e: VehicleEntity): Frame {
    const sv = this.sim?.vehicles.get(e.id);
    if (sv && sv.frames.length) return frameAt(sv, this.time);
    return { t: this.time, x: e.x, z: e.z, h: e.heading, v: 0, ax: 0, ay: 0, steer: 0, vx: 0, vz: 0 };
  }

  /** Coloca el vehículo sobre el firme, inclinado por la pendiente y por sus aceleraciones. */
  placeVehicle(obj: THREE.Object3D, e: VehicleEntity) {
    const sp = e.spec;
    const pose = this.vehiclePose(e);
    const a = (-pose.h * Math.PI) / 180;
    const hd = (pose.h * Math.PI) / 180;
    const fwd = new THREE.Vector3(Math.sin(hd), 0, -Math.cos(hd));
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
    const ped = sp.tipo === 'peaton';
    // cabeceo al frenar/acelerar y balanceo en curva (suspensión)
    const dyn = ped ? 0 : 1;
    const pitch = ped ? 0 : Math.atan2(yF - yR, hf + hr) + dyn * Math.max(-0.06, Math.min(0.06, pose.ax * 0.0055));
    const roll = ped ? 0 : Math.atan2(yRt - yL, 2 * hw) + dyn * Math.max(-0.07, Math.min(0.07, pose.ay * 0.007));
    obj.rotation.set(pitch, a, roll, 'YXZ');
    // ruedas delanteras giradas
    obj.traverse((c) => {
      if (c.userData.wheel && c.userData.axle === 'front') c.rotation.y = (c.userData.baseRotY ?? 0) - pose.steer;
    });
    // daños visibles desde el primer contacto
    const sv = this.sim?.vehicles.get(e.id);
    const showDamaged = !sv || sv.firstContact === null || this.time >= sv.firstContact;
    const hasIntact = obj.children.some((x) => x.userData.state === 'intact');
    for (const c of obj.children) {
      if (c.userData.state === 'intact') c.visible = !showDamaged;
      if (c.userData.state === 'damaged') c.visible = showDamaged || !hasIntact;
    }
  }

  /** Coloca los vehículos en el instante t. */
  setTime(t: number) {
    this.time = t;
    for (const e of this.store.project.entities) {
      if (e.kind !== 'vehicle') continue;
      const obj = this.objects.get(e.id);
      if (obj) this.placeVehicle(obj, e);
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
