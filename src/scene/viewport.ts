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
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.zoomToCursor = true;

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

  private frame() {
    this.timer.update();
    const dt = Math.min(0.1, this.timer.getDelta());
    this.controls.update();
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
      this.sun.position.copy(dir.clone().multiplyScalar(400));
      this.sun.color.setHSL(0.09, 0.7 * (1 - day) + 0.1, 0.5 + 0.45 * day);
      this.sun.intensity = 0.4 + 2.8 * day;
    } else {
      // Luz de luna difusa (la escena debe seguir siendo legible de noche)
      const moon = new THREE.Vector3(0.35, 0.75, 0.45).normalize();
      this.sun.position.copy(moon.multiplyScalar(400));
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

  /** Vista cenital (planta) sobre el punto de interés actual. */
  topView() {
    const t = this.controls.target;
    const d = Math.max(30, this.camera.position.distanceTo(t));
    this.camera.position.set(t.x, t.y + d, t.z + 0.001);
    this.controls.update();
  }

  focus(p: THREE.Vector3, dist = 30) {
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(p);
    this.camera.position.copy(p.clone().add(dir.multiplyScalar(dist)));
  }
}
