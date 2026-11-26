import * as THREE from 'three';
import type { PhotoEntity } from '../model/types';
import { DEG } from './utils';

const markerMat = new THREE.MeshStandardMaterial({ color: 0x1fb6d9, roughness: 0.4, metalness: 0.2, emissive: 0x06303a });
const lineMat = new THREE.LineBasicMaterial({ color: 0x1fb6d9 });

/** Marcador en la escena: trípode con cámara y abanico que indica el encuadre. */
export function buildPhotoMarker(e: PhotoEntity, groundY: number): THREE.Object3D {
  const g = new THREE.Group();
  g.position.set(e.x, groundY, e.z);
  const H = e.height;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, H, 8).translate(0, H / 2, 0), markerMat);
  const head = new THREE.Group();
  head.position.y = H;
  head.rotation.order = 'YXZ';
  head.rotation.set(e.pitch * DEG, -e.heading * DEG, e.roll * DEG);
  head.add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.08), markerMat));
  // abanico de visión
  const fov = e.mode === 'esferica' ? 90 : Math.min(170, e.hfov);
  const L = 3;
  const hw = Math.tan((fov / 2) * DEG) * L;
  const hh = hw * Math.min(1, e.aspect);
  const pts = [
    [0, 0, 0],
    [-hw, hh, -L],
    [0, 0, 0],
    [hw, hh, -L],
    [0, 0, 0],
    [hw, -hh, -L],
    [0, 0, 0],
    [-hw, -hh, -L],
    [-hw, hh, -L],
    [hw, hh, -L],
    [hw, hh, -L],
    [hw, -hh, -L],
    [hw, -hh, -L],
    [-hw, -hh, -L],
    [-hw, -hh, -L],
    [-hw, hh, -L],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  head.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
  g.add(pole, head);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.castShadow = true;
  });
  return g;
}

/**
 * Superposición de la foto vista desde su punto de toma.
 * El objeto se coloca en la posición de la cámara; su «centro» mira al rumbo indicado.
 */
export function buildPhotoOverlay(e: PhotoEntity, tex: THREE.Texture): THREE.Object3D {
  const R = 30;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: e.opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  let geo: THREE.BufferGeometry;
  if (e.mode === 'esferica') {
    geo = new THREE.SphereGeometry(R, 96, 48);
    geo.scale(-1, 1, 1);
    geo.rotateY(-Math.PI / 2);
  } else if (e.mode === 'cilindrica') {
    const L = Math.min(360, Math.max(10, e.hfov)) * DEG;
    const height = R * L * e.aspect;
    geo = new THREE.CylinderGeometry(R, R, height, 128, 1, true, Math.PI - L / 2, L);
    geo.scale(-1, 1, 1);
  } else {
    const w = 2 * R * Math.tan((Math.min(170, Math.max(5, e.hfov)) / 2) * DEG);
    geo = new THREE.PlaneGeometry(w, w * e.aspect);
    geo.translate(0, 0, -R);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 50;
  mesh.frustumCulled = false;
  const holder = new THREE.Group();
  holder.rotation.order = 'YXZ';
  holder.add(mesh);
  placePhotoOverlay(holder, e, 0);
  return holder;
}

export function placePhotoOverlay(holder: THREE.Object3D, e: PhotoEntity, groundY: number) {
  holder.position.set(e.x, groundY + e.height, e.z);
  holder.rotation.set(e.pitch * DEG, -e.heading * DEG, e.roll * DEG);
  const m = holder.children[0] as THREE.Mesh;
  (m.material as THREE.MeshBasicMaterial).opacity = e.opacity;
}
