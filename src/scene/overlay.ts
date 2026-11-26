import * as THREE from 'three';
import type { OverlayEntity } from '../model/types';
import { DEG } from './utils';

/**
 * Calcos: imágenes (croquis, capturas, ortofotos) proyectadas en planta sobre el terreno
 * y, opcionalmente, sobre las carreteras. Se inyectan en los shaders de los materiales de suelo,
 * así se adaptan al relieve sin geometría adicional.
 */
export const MAX_OVERLAYS = 3;

const empty = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
empty.needsUpdate = true;

interface OverlayUniforms {
  ovMap0: { value: THREE.Texture };
  ovMap1: { value: THREE.Texture };
  ovMap2: { value: THREE.Texture };
  ovMat0: { value: THREE.Matrix3 };
  ovMat1: { value: THREE.Matrix3 };
  ovMat2: { value: THREE.Matrix3 };
  ovOpacity: { value: THREE.Vector3 };
}

function makeUniforms(): OverlayUniforms {
  return {
    ovMap0: { value: empty },
    ovMap1: { value: empty },
    ovMap2: { value: empty },
    ovMat0: { value: new THREE.Matrix3() },
    ovMat1: { value: new THREE.Matrix3() },
    ovMat2: { value: new THREE.Matrix3() },
    ovOpacity: { value: new THREE.Vector3() },
  };
}

const groundUniforms = makeUniforms();
const roadUniforms = makeUniforms();

const FRAG_DECL = /* glsl */ `
varying vec3 vOvPos;
uniform sampler2D ovMap0; uniform sampler2D ovMap1; uniform sampler2D ovMap2;
uniform mat3 ovMat0; uniform mat3 ovMat1; uniform mat3 ovMat2;
uniform vec3 ovOpacity;
vec3 ovApply(vec3 col, sampler2D m, mat3 t, float op) {
  if (op <= 0.0) return col;
  vec2 uv = (t * vec3(vOvPos.x, vOvPos.z, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return col;
  vec4 c = texture2D(m, uv);
  return mix(col, c.rgb, c.a * op);
}
`;

const FRAG_APPLY = /* glsl */ `
diffuseColor.rgb = ovApply(diffuseColor.rgb, ovMap0, ovMat0, ovOpacity.x);
diffuseColor.rgb = ovApply(diffuseColor.rgb, ovMap1, ovMat1, ovOpacity.y);
diffuseColor.rgb = ovApply(diffuseColor.rgb, ovMap2, ovMat2, ovOpacity.z);
`;

/** Añade el soporte de calcos a un material estándar. */
export function patchOverlay(mat: THREE.MeshStandardMaterial, target: 'ground' | 'road') {
  const u = target === 'ground' ? groundUniforms : roadUniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vOvPos;')
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\nvOvPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FRAG_DECL)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + FRAG_APPLY);
  };
  mat.customProgramCacheKey = () => 'overlay-' + target;
}

/** Matriz mundo(x,z) → uv de la imagen. */
export function overlayMatrix(o: OverlayEntity, out = new THREE.Matrix3()) {
  const w = o.width;
  const h = o.width * o.aspect;
  const c = Math.cos(o.rot * DEG);
  const s = Math.sin(o.rot * DEG);
  const a = c / w;
  const bb = s / w;
  const d = s / h;
  const e = -c / h;
  return out.set(a, bb, 0.5 - a * o.cx - bb * o.cz, d, e, 0.5 - d * o.cx - e * o.cz, 0, 0, 1);
}

/** Esquinas del calco en el mundo (para dibujar su contorno). */
export function overlayCorners(o: OverlayEntity): [number, number][] {
  const w = o.width / 2;
  const h = (o.width * o.aspect) / 2;
  const c = Math.cos(o.rot * DEG);
  const s = Math.sin(o.rot * DEG);
  return [
    [-w, -h],
    [w, -h],
    [w, h],
    [-w, h],
  ].map(([lx, lz]) => [o.cx + lx * c - lz * s, o.cz + lx * s + lz * c]);
}

const texCache = new Map<string, THREE.Texture>();

function textureFor(assetId: string, dataUrl: string): THREE.Texture {
  let t = texCache.get(assetId);
  if (!t) {
    t = new THREE.TextureLoader().load(dataUrl);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    texCache.set(assetId, t);
  }
  return t;
}

/** Actualiza los uniforms a partir de las entidades de calco visibles (máx. 3). */
export function updateOverlays(list: OverlayEntity[], assets: Map<string, string>) {
  const visible = list.filter((o) => !o.hidden && assets.has(o.asset)).slice(0, MAX_OVERLAYS);
  const sets: [OverlayUniforms, boolean][] = [
    [groundUniforms, false],
    [roadUniforms, true],
  ];
  for (const [u, roadsOnly] of sets) {
    const maps = [u.ovMap0, u.ovMap1, u.ovMap2];
    const mats = [u.ovMat0, u.ovMat1, u.ovMat2];
    const op = [0, 0, 0];
    for (let i = 0; i < MAX_OVERLAYS; i++) {
      const o = visible[i];
      if (!o || (roadsOnly && !o.onRoads)) {
        maps[i].value = empty;
        continue;
      }
      maps[i].value = textureFor(o.asset, assets.get(o.asset)!);
      overlayMatrix(o, mats[i].value);
      op[i] = o.opacity;
    }
    u.ovOpacity.value.set(op[0], op[1], op[2]);
  }
}
