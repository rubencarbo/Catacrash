import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { Environment, GeoRef } from '../model/types';
import { DEG, clamp } from './utils';

/** Posición solar aproximada (suficiente para luz y sombras verosímiles). */
export function sunPosition(env: Environment, lat = 40.4, lon = -3.7) {
  const N = (env.month - 1) * 30.44 + 15;
  const decl = 23.44 * DEG * Math.sin((2 * Math.PI * (284 + N)) / 365);
  const summer = env.month >= 4 && env.month <= 10;
  const solar = env.hour - (summer ? 2 : 1) + lon / 15;
  const H = (solar - 12) * 15 * DEG;
  const phi = lat * DEG;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(clamp(sinEl, -1, 1));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI;
  return { elevation: el, azimuth: az };
}

export type MouseStyle = 'mapa' | '3d';

export class Viewport {
  dom: HTMLElement;
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun = new THREE.DirectionalLight(0xffffff, 3);
  hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a5040, 0.6);
  sky = new Sky();
  private pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private frameCbs: ((dt: number) => void)[] = [];
  private timer = new THREE.Timer();
  sunInfo = { elevation: 0, azimuth: 0 };

  constructor(dom: HTMLElement) {
    this.dom = dom;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    dom.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels-layer';
    dom.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 6000);
    this.camera.position.set(-70, 60, 95);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = 89 * DEG;
    this.controls.minDistance = 1;
    this.controls.maxDistance = 1500;
    this.controls.zoomToCursor = true;
    let style: MouseStyle = 'mapa';
    try {
      if (localStorage.getItem('catacrash.mouse') === '3d') style = '3d';
    } catch {
      /* sin almacenamiento */
    }
    this.setMouseStyle(style);
    this.installKeys();
    // si el usuario toma el control, se interrumpe cualquier viaje de cámara
    this.controls.addEventListener('start', () => (this.flight = null));

    this.sky.scale.setScalar(4500);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 6;
    u.rayleigh.value = 1.6;
    u.mieCoefficient.value = 0.005;
    u.mieDirectionalG.value = 0.8;
    this.scene.add(this.sky);

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -170;
    sc.right = sc.top = 170;
    sc.near = 1;
    sc.far = 900;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target, this.hemi);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    new ResizeObserver(() => this.resize()).observe(dom);
    this.resize();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  /** Ajusta la cámara de sombras al tamaño del terreno. */
  setShadowExtent(half: number) {
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -half;
    sc.right = sc.top = half;
    sc.far = Math.max(900, half * 5);
    sc.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(1500, half * 5);
  }

  onFrame(cb: (dt: number) => void) {
    this.frameCbs.push(cb);
  }

  private resize() {
    const w = this.dom.clientWidth || 1;
    const h = this.dom.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Sin dibujar (p. ej. mientras un cálculo largo ocupa el procesador con la escena tapada). */
  paused = false;

  private frame() {
    if (this.paused) return;
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    this.stepFlight();
    this.stepKeys(dt);
    this.controls.update();
    // la cámara nunca atraviesa el suelo
    if (this.groundHeight) {
      const c = this.camera.position;
      const g = this.groundHeight(c.x, c.z) + 1.2;
      if (c.y < g) c.y = g;
    }
    for (const cb of this.frameCbs) cb(dt);
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  /** Coordenadas normalizadas de un evento de puntero. */
  ndc(e: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  raycaster(e: { clientX: number; clientY: number }) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(this.ndc(e), this.camera);
    return rc;
  }

  /** Iluminación y cielo según la hora, el mes y la ubicación. */
  setEnvironment(env: Environment, geo: GeoRef | null) {
    const { elevation, azimuth } = sunPosition(env, geo?.lat, geo?.lon);
    this.sunInfo = { elevation, azimuth };
    const el = Math.max(elevation, -0.2);
    const dir = new THREE.Vector3(Math.cos(el) * Math.sin(azimuth), Math.sin(el), -Math.cos(el) * Math.cos(azimuth));
    this.sky.material.uniforms.sunPosition.value.copy(dir);

    const sinEl = Math.sin(elevation);
    const day = clamp(sinEl * 4, 0, 1); // pleno día por encima de ~15°
    const twilight = clamp((sinEl + 0.1) * 10, 0, 1); // 0 = noche cerrada, 1 = sol en el horizonte
    if (elevation > 0) {
      this.sun.position.copy(dir.clone().multiplyScalar(Math.max(400, -this.sun.shadow.camera.left * 2.2)));
      this.sun.color.setHSL(0.09, 0.7 * (1 - day) + 0.1, 0.5 + 0.45 * day);
      this.sun.intensity = 0.4 + 2.8 * day;
    } else {
      // Luz de luna difusa (la escena debe seguir siendo legible de noche)
      const moon = new THREE.Vector3(0.35, 0.75, 0.45).normalize();
      this.sun.position.copy(moon.multiplyScalar(Math.max(400, -this.sun.shadow.camera.left * 2.2)));
      this.sun.color.set(0x9db4e0);
      this.sun.intensity = 0.8 + 0.4 * twilight;
    }
    this.hemi.intensity = 0.8 + 0.1 * day;
    this.hemi.color.copy(new THREE.Color(0x4a5a85).lerp(new THREE.Color(0xcfe3ff), twilight));
    this.hemi.groundColor.copy(new THREE.Color(0x1c1a18).lerp(new THREE.Color(0x5a5040), twilight));
    this.renderer.toneMappingExposure = 0.55 + (1 - day) * 0.35;

    // Mapa de entorno desde el cielo (reflejos en asfalto mojado, agua, metal)
    const skyScene = new THREE.Scene();
    const skyClone = new Sky();
    skyClone.scale.setScalar(4500);
    for (const k of Object.keys(this.sky.material.uniforms)) {
      const v = this.sky.material.uniforms[k].value;
      skyClone.material.uniforms[k].value = v?.clone ? v.clone() : v;
    }
    skyScene.add(skyClone);
    this.envRT?.dispose();
    this.envRT = this.pmrem.fromScene(skyScene, 0, 0.1, 5000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.08 + 0.3 * day;
    skyClone.material.dispose();

    if (env.fog > 0) {
      const c = new THREE.Color(0x1b2130).lerp(new THREE.Color(0xc9cfd4), Math.max(day, twilight * 0.3));
      this.scene.fog = new THREE.FogExp2(c, 0.002 + env.fog * 0.035);
    } else this.scene.fog = null;
  }

  // ---------------- navegación ----------------

  /** Cota del suelo bajo un punto (para que la cámara no lo atraviese). */
  groundHeight: ((x: number, z: number) => number) | null = null;
  mouseStyle: MouseStyle = 'mapa';

  /**
   * Manejo del ratón. «mapa» (como Google Maps): arrastrar con el izquierdo desplaza, con el
   * derecho gira e inclina, la rueda acerca hacia el cursor. «3d»: el izquierdo gira, el derecho desplaza.
   */
  setMouseStyle(style: MouseStyle) {
    this.mouseStyle = style;
    this.controls.mouseButtons =
      style === 'mapa' ? { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controls.touches = style === 'mapa' ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    try {
      localStorage.setItem('catacrash.mouse', style);
    } catch {
      /* sin almacenamiento */
    }
  }

  private flight: { t0: number; ms: number; fromT: THREE.Vector3; toT: THREE.Vector3; fromP: THREE.Vector3; toP: THREE.Vector3 } | null = null;

  /** Viaje suave de la cámara a un nuevo punto de interés y posición. */
  flyTo(target: THREE.Vector3, position: THREE.Vector3, ms = 650) {
    this.flight = { t0: performance.now(), ms, fromT: this.controls.target.clone(), toT: target.clone(), fromP: this.camera.position.clone(), toP: position.clone() };
  }
  get flying() {
    return !!this.flight;
  }
  private stepFlight() {
    const f = this.flight;
    if (!f) return;
    const u = Math.min(1, (performance.now() - f.t0) / f.ms);
    const k = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    // interpolación en coordenadas esféricas alrededor del objetivo (gira en vez de atravesar)
    const tgt = f.fromT.clone().lerp(f.toT, k);
    const a = new THREE.Spherical().setFromVector3(f.fromP.clone().sub(f.fromT));
    const b = new THREE.Spherical().setFromVector3(f.toP.clone().sub(f.toT));
    let dth = b.theta - a.theta;
    while (dth > Math.PI) dth -= 2 * Math.PI;
    while (dth < -Math.PI) dth += 2 * Math.PI;
    const sp = new THREE.Spherical(a.radius + (b.radius - a.radius) * k, a.phi + (b.phi - a.phi) * k, a.theta + dth * k);
    this.controls.target.copy(tgt);
    this.camera.position.copy(tgt).add(new THREE.Vector3().setFromSpherical(sp));
    if (u >= 1) this.flight = null;
  }

  private orbit() {
    return new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
  }
  private fromOrbit(sp: THREE.Spherical, target = this.controls.target) {
    return target.clone().add(new THREE.Vector3().setFromSpherical(sp));
  }

  /** Vista cenital (planta) sobre el punto de interés actual, con el norte arriba. */
  topView() {
    const sp = this.orbit();
    sp.phi = 0.0008;
    sp.theta = 0;
    sp.radius = Math.max(30, sp.radius);
    this.flyTo(this.controls.target, this.fromOrbit(sp));
  }
  /** Vista en perspectiva (inclinada) manteniendo la orientación. */
  view3d() {
    const sp = this.orbit();
    sp.phi = 55 * DEG;
    this.flyTo(this.controls.target, this.fromOrbit(sp));
  }
  get isTop() {
    return this.orbit().phi < 8 * DEG;
  }
  /** Gira la vista alrededor del punto de interés. */
  rotateBy(deg: number) {
    const sp = this.orbit();
    sp.theta += deg * DEG;
    this.flyTo(this.controls.target, this.fromOrbit(sp), 350);
  }
  /** Norte arriba. */
  northUp() {
    const sp = this.orbit();
    sp.theta = 0;
    this.flyTo(this.controls.target, this.fromOrbit(sp), 450);
  }
  zoomBy(f: number) {
    const sp = this.orbit();
    sp.radius = Math.min(this.controls.maxDistance, Math.max(3, sp.radius * f));
    this.flyTo(this.controls.target, this.fromOrbit(sp), 300);
  }

  focus(p: THREE.Vector3, dist = 30) {
    const sp = this.orbit();
    sp.radius = dist;
    if (sp.phi > 75 * DEG) sp.phi = 55 * DEG;
    this.flyTo(p, this.fromOrbit(sp, p));
  }

  /** Encuadra una caja (vista desde la orientación actual). */
  frameBox(box: THREE.Box3) {
    if (box.isEmpty()) return;
    const s = new THREE.Sphere();
    box.getBoundingSphere(s);
    const dist = Math.max(12, s.radius / Math.tan((this.camera.fov * DEG) / 2) * 1.05);
    this.focus(s.center, dist);
  }

  // teclado: flechas desplazan, Q/E giran, +/− acercan
  private keys = new Set<string>();
  private installKeys() {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    };
    window.addEventListener('keydown', (e) => {
      if (typing(e) || e.ctrlKey || e.metaKey) return;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        this.keys.add(e.key);
        e.preventDefault();
      } else
        // después de que el editor y sus herramientas hayan podido usar la tecla
        queueMicrotask(() => {
          if (e.defaultPrevented) return;
          if (e.key === 'q' || e.key === 'Q') this.rotateBy(-15);
          else if (e.key === 'e' || e.key === 'E') this.rotateBy(15);
          else if (e.key === '+' || e.key === '=') this.zoomBy(0.7);
          else if (e.key === '-') this.zoomBy(1.4);
        });
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    window.addEventListener('blur', () => this.keys.clear());
  }
  private stepKeys(dt: number) {
    if (!this.keys.size) return;
    const fwd = this.controls.target.clone().sub(this.camera.position).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const speed = Math.max(8, this.camera.position.distanceTo(this.controls.target) * 0.9) * dt;
    const m = new THREE.Vector3();
    if (this.keys.has('ArrowUp')) m.add(fwd);
    if (this.keys.has('ArrowDown')) m.sub(fwd);
    if (this.keys.has('ArrowRight')) m.add(right);
    if (this.keys.has('ArrowLeft')) m.sub(right);
    m.multiplyScalar(speed);
    this.camera.position.add(m);
    this.controls.target.add(m);
  }
}
