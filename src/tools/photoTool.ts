import * as THREE from 'three';
import type { Editor, Tool } from '../editor';
import { newId } from '../model/store';
import type { PhotoEntity } from '../model/types';
import { buildPhotoOverlay } from '../scene/photo';
import { DEG } from '../scene/utils';
import { fmt, h, toast } from '../ui/dom';
import { ICON } from '../ui/icons';
import { pickEntity } from './basic';
import { readImage } from './overlayTool';

const MODES: [PhotoEntity['mode'], string, number][] = [
  ['plana', 'Foto normal (móvil, cámara, captura de Street View)', 65],
  ['cilindrica', 'Panorámica de móvil (barrido horizontal)', 180],
  ['esferica', 'Foto 360° (equirectangular)', 360],
];

const texCache = new Map<string, THREE.Texture>();
function photoTexture(asset: string, url: string) {
  let t = texCache.get(asset);
  if (!t) {
    t = new THREE.TextureLoader().load(url);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texCache.set(asset, t);
  }
  return t;
}

/**
 * Fotos de referencia: se sitúan en el punto de toma y se superponen a la escena
 * vista desde ese mismo punto para comprobar que todo coincide.
 */
export function photoTool(ed: Editor): Tool {
  const vp = ed.vp;
  let mode: PhotoEntity['mode'] = 'plana';
  let hfov = 65;
  let pending: { asset: string; aspect: number; name: string } | null = null;
  let matching: string | null = null;
  let overlay: THREE.Object3D | null = null;
  let saved: { pos: THREE.Vector3; target: THREE.Vector3; fov: number } | null = null;
  let lastSig = '';

  const photo = () => (matching ? (ed.store.get(matching) as PhotoEntity | undefined) : undefined);
  const eye = (e: PhotoEntity) => new THREE.Vector3(e.x, ed.world.terrain.height(e.x, e.z) + e.height, e.z);
  const dirOf = (headingDeg: number, pitchDeg: number) =>
    new THREE.Vector3(Math.sin(headingDeg * DEG) * Math.cos(pitchDeg * DEG), Math.sin(pitchDeg * DEG), -Math.cos(headingDeg * DEG) * Math.cos(pitchDeg * DEG));

  const lookAlong = (dir: THREE.Vector3) => {
    const e = photo();
    if (!e) return;
    const p = eye(e);
    vp.camera.position.copy(p);
    vp.controls.target.copy(p.clone().add(dir.clone().normalize().multiplyScalar(0.05)));
    vp.controls.update();
  };

  const refreshOverlay = () => {
    const e = photo();
    if (!e) return;
    const sig = `${e.mode}|${e.hfov}|${e.aspect}|${e.asset}`;
    const url = ed.store.assets.get(e.asset);
    if (!url) return;
    if (!overlay || sig !== lastSig) {
      if (overlay) vp.scene.remove(overlay);
      overlay = buildPhotoOverlay(e, photoTexture(e.asset, url));
      vp.scene.add(overlay);
      lastSig = sig;
    }
    overlay.position.copy(eye(e));
    overlay.rotation.set(e.pitch * DEG, -e.heading * DEG, e.roll * DEG);
    const m = overlay.children[0] as THREE.Mesh;
    (m.material as THREE.MeshBasicMaterial).opacity = e.opacity;
    // la cámara sigue en el punto de toma (si cambió la altura o la posición)
    const dir = vp.controls.target.clone().sub(vp.camera.position);
    if (vp.camera.position.distanceTo(eye(e)) > 0.01) lookAlong(dir.lengthSq() > 0 ? dir : dirOf(e.heading, e.pitch));
  };

  const onWheel = (ev: WheelEvent) => {
    if (!matching) return;
    ev.preventDefault();
    ev.stopPropagation();
    vp.camera.fov = Math.max(10, Math.min(110, vp.camera.fov * (ev.deltaY > 0 ? 1.06 : 1 / 1.06)));
    vp.camera.updateProjectionMatrix();
  };
  vp.dom.addEventListener('wheel', onWheel, { capture: true, passive: false });

  const startMatch = (id: string) => {
    const e = ed.store.get(id) as PhotoEntity | undefined;
    if (!e) return;
    if (!saved) saved = { pos: vp.camera.position.clone(), target: vp.controls.target.clone(), fov: vp.camera.fov };
    matching = id;
    ed.select(id);
    vp.controls.enableZoom = false;
    vp.controls.enablePan = false;
    vp.controls.rotateSpeed = -0.3;
    vp.controls.minDistance = 0;
    vp.controls.maxPolarAngle = Math.PI; // poder mirar en horizontal sin que la órbita incline la vista
    vp.controls.enableDamping = false;
    vp.camera.fov = e.mode === 'plana' ? Math.min(100, Math.max(20, (2 * Math.atan(Math.tan((e.hfov / 2) * DEG) * e.aspect)) / DEG)) : 70;
    vp.camera.updateProjectionMatrix();
    lookAlong(dirOf(e.heading, e.pitch));
    refreshOverlay();
    ed.refreshOptions?.();
  };

  const stopMatch = () => {
    if (overlay) vp.scene.remove(overlay);
    overlay = null;
    lastSig = '';
    matching = null;
    vp.controls.enableZoom = true;
    vp.controls.enablePan = true;
    vp.controls.rotateSpeed = 1;
    vp.controls.minDistance = 1;
    vp.controls.maxPolarAngle = 89 * DEG;
    vp.controls.enableDamping = true;
    if (saved) {
      vp.camera.position.copy(saved.pos);
      vp.controls.target.copy(saved.target);
      vp.camera.fov = saved.fov;
      vp.camera.updateProjectionMatrix();
      saved = null;
    }
    ed.refreshOptions?.();
  };

  ed.store.on((c) => {
    if (!matching) return;
    if (!ed.store.get(matching)) return stopMatch();
    if (c.type === 'all' || (c.type === 'entity' && c.id === matching)) refreshOverlay();
  });
  ed.photoMatch = (id: string) => {
    ed.setTool('photo');
    startMatch(id);
  };

  const slider = (e: PhotoEntity, label: string, key: 'heading' | 'pitch' | 'roll' | 'height' | 'hfov' | 'opacity', min: number, max: number, step: number, unit: string) => {
    const show = (v: number) => (key === 'opacity' ? `${Math.round(v * 100)} %` : `${fmt(v, step < 0.1 ? 2 : 1)}${unit}`);
    const out = h('output', {}, show(e[key]));
    return h(
      'label',
      { class: 'field' },
      h('span', {}, label),
      h('input', {
        type: 'range',
        min,
        max,
        step,
        value: e[key],
        onpointerdown: () => ed.store.begin(),
        oninput: (ev: Event) => {
          e[key] = Number((ev.target as HTMLInputElement).value);
          out.textContent = show(e[key]);
          ed.store.notify({ type: 'entity', id: e.id });
        },
        onchange: () => ed.store.end(),
      }),
      out,
    );
  };

  const nudge = (key: 'heading' | 'pitch' | 'roll' | 'hfov', d: number) => {
    const e = photo();
    if (!e) return;
    ed.store.edit(() => {
      e[key] = key === 'heading' ? (((e[key] + d) % 360) + 360) % 360 : e[key] + d;
    }, { type: 'entity', id: e.id });
    ed.refreshOptions?.();
  };

  return {
    id: 'photo',
    label: 'Fotos de referencia',
    icon: ICON.camera,
    key: 'i',
    handles: true,
    hint: 'Añade una foto y haz clic donde se tomó · En modo coincidir: arrastra para mirar, rueda = zoom, flechas = rumbo/inclinación',
    deactivate() {
      if (matching) stopMatch();
      pending = null;
    },
    click(ev) {
      if (matching) return;
      if (pending && ev.ground) {
        const e: PhotoEntity = {
          id: newId('f'),
          kind: 'photo',
          name: pending.name,
          asset: pending.asset,
          x: ev.ground.x,
          z: ev.ground.z,
          height: 1.6,
          heading: 0,
          pitch: 0,
          roll: 0,
          mode,
          hfov: mode === 'esferica' ? 360 : hfov,
          aspect: pending.aspect,
          opacity: 0.6,
        };
        // Orientar inicialmente hacia donde mira la cámara actual
        const d = vp.controls.target.clone().sub(vp.camera.position);
        e.heading = ((Math.atan2(d.x, -d.z) / DEG) % 360 + 360) % 360;
        pending = null;
        ed.store.add(e);
        startMatch(e.id);
        toast('Ajusta rumbo, inclinación y altura hasta que la foto encaje con la escena.');
        return;
      }
      ed.select(pickEntity(ed, ev));
    },
    onKey(e) {
      if (!matching) {
        if (e.key === 'Escape' && pending) {
          pending = null;
          ed.refreshOptions?.();
          return true;
        }
        return false;
      }
      const k = e.shiftKey ? 2 : 0.25;
      switch (e.key) {
        case 'Escape':
          stopMatch();
          return true;
        case 'ArrowLeft':
          nudge('heading', -k);
          return true;
        case 'ArrowRight':
          nudge('heading', k);
          return true;
        case 'ArrowUp':
          nudge('pitch', k);
          return true;
        case 'ArrowDown':
          nudge('pitch', -k);
          return true;
        case ',':
          nudge('roll', -k);
          return true;
        case '.':
          nudge('roll', k);
          return true;
      }
      return false;
    },
    options(el) {
      const e = photo();
      if (e) {
        el.append(
          h('div', { class: 'cat-title' }, `Coincidir: ${e.name}`),
          h('p', { class: 'muted' }, 'Arrastra para mirar alrededor y rueda para el zoom. Mueve los controles hasta que bordillos, postes y edificios de la foto se superpongan con la escena.'),
          slider(e, 'Opacidad', 'opacity', 0, 1, 0.01, ''),
          slider(e, 'Rumbo', 'heading', 0, 360, 0.1, '°'),
          slider(e, 'Inclinación', 'pitch', -30, 30, 0.1, '°'),
          slider(e, 'Giro', 'roll', -20, 20, 0.1, '°'),
          slider(e, 'Altura cámara', 'height', 0.3, 6, 0.01, ' m'),
        );
        if (e.mode !== 'esferica') el.append(slider(e, 'Campo horizontal', 'hfov', e.mode === 'plana' ? 10 : 60, e.mode === 'plana' ? 150 : 360, 0.5, '°'));
        el.append(
          h(
            'div',
            { class: 'row wrap' },
            h('button', { class: 'btn', onclick: () => lookAlong(dirOf(e.heading, e.pitch)) }, 'Mirar al centro de la foto'),
            h('button', { class: 'btn primary', onclick: stopMatch }, 'Salir'),
          ),
          h('p', { class: 'muted' }, 'Teclado: ← → rumbo · ↑ ↓ inclinación · , . giro (Mayús = paso grande) · Esc salir. Si la foto no encaja moviéndola, corrige la escena: la foto es la referencia real.'),
        );
        return;
      }
      if (pending) {
        el.append(h('p', {}, `Haz clic en la escena en el punto donde se tomó «${pending.name}».`), h('button', { class: 'btn', onclick: () => ((pending = null), ed.refreshOptions?.()) }, 'Cancelar'));
        return;
      }
      const m = h('select', {
        onchange: (ev: Event) => {
          mode = (ev.target as HTMLSelectElement).value as PhotoEntity['mode'];
          hfov = MODES.find((x) => x[0] === mode)![2];
          ed.refreshOptions?.();
        },
      });
      for (const [k, l] of MODES) m.append(h('option', { value: k, selected: k === mode }, l));
      const file = h('input', {
        type: 'file',
        accept: 'image/*',
        style: 'display:none',
        onchange: async (ev: Event) => {
          const f = (ev.target as HTMLInputElement).files?.[0];
          if (!f) return;
          try {
            const { url, aspect } = await readImage(f, false);
            const asset = newId('img');
            ed.store.assets.set(asset, url);
            pending = { asset, aspect, name: f.name.replace(/\.[^.]+$/, '') };
            ed.refreshOptions?.();
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        },
      });
      el.append(
        h('label', { class: 'field wide' }, m),
        mode !== 'esferica'
          ? h(
              'label',
              { class: 'field' },
              h('span', {}, 'Campo horizontal'),
              h('input', { type: 'number', min: 10, max: 360, step: 1, value: hfov, onchange: (ev: Event) => (hfov = Number((ev.target as HTMLInputElement).value)) }),
              h('output', {}, '°'),
            )
          : '',
        file,
        h('button', { class: 'btn primary', onclick: () => file.click() }, 'Añadir foto…'),
        h(
          'p',
          { class: 'muted' },
          'Valores orientativos de campo horizontal: móvil normal 65–70°, gran angular 100–120°, panorámica de móvil 150–240°. Se puede afinar después.',
        ),
      );
      const photos = ed.store.project.entities.filter((x): x is PhotoEntity => x.kind === 'photo');
      if (photos.length) {
        el.append(h('div', { class: 'cat-title' }, 'Fotos en la escena'));
        for (const p of photos)
          el.append(
            h(
              'div',
              { class: 'band-row', style: 'grid-template-columns:1fr auto' },
              h('span', {}, p.name),
              h('button', { class: 'btn small', onclick: () => startMatch(p.id) }, 'Coincidir'),
            ),
          );
      }
    },
  };
}
