import * as THREE from 'three';
import type { Editor, Tool } from '../editor';
import type { SculptMode } from '../scene/terrain';
import { h, fmt } from '../ui/dom';
import { ICON } from '../ui/icons';
import { valueNoise2D } from '../scene/utils';

const MODES: [SculptMode, string][] = [
  ['subir', 'Subir'],
  ['bajar', 'Bajar'],
  ['suavizar', 'Suavizar'],
  ['aplanar', 'Aplanar'],
  ['cota', 'A cota fija'],
];

/** Modelado del terreno con pincel: desniveles, barrancos, terraplenes, rampas… */
export function sculptTool(ed: Editor): Tool {
  const o = { mode: 'subir' as SculptMode, radius: 10, strength: 0.6, target: 0 };
  let active = false;
  let at: THREE.Vector3 | null = null;
  let dirty = false;

  const ringGeo = new THREE.BufferGeometry();
  const ring = new THREE.LineLoop(ringGeo, new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false }));
  ring.renderOrder = 12;
  ring.visible = false;
  ed.vp.scene.add(ring);

  const drawRing = (p: THREE.Vector3) => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const x = p.x + Math.cos(a) * o.radius;
      const z = p.z + Math.sin(a) * o.radius;
      pts.push(new THREE.Vector3(x, ed.world.terrain.height(x, z) + 0.15, z));
    }
    ringGeo.setFromPoints(pts);
    ring.visible = true;
  };

  ed.vp.onFrame((dt) => {
    if (!active || !at) return;
    const t = ed.world.terrain;
    const k = o.mode === 'subir' || o.mode === 'bajar' ? o.strength * 6 * dt : o.strength * 4 * dt;
    t.sculpt(at.x, at.z, o.mode, o.radius, k, o.target);
    dirty = true;
    ed.world.previewTerrain();
    drawRing(at);
  });

  const commit = () => {
    if (!dirty) return;
    dirty = false;
    ed.store.end();
    ed.store.notify({ type: 'terrain' });
  };

  return {
    id: 'terrain',
    label: 'Modelar terreno',
    icon: ICON.terrain,
    key: 't',
    hint: 'Arrastrar: modelar · Alt+arrastrar: girar cámara · [ / ]: radio · Ctrl+clic: tomar cota',
    deactivate() {
      ring.visible = false;
      active = false;
    },
    down(ev) {
      const e = ev.e as PointerEvent;
      if (e.altKey || !ev.ground) return false;
      if (e.ctrlKey) {
        o.target = ev.ground.y;
        ed.refreshOptions?.();
        return true;
      }
      if (o.mode === 'aplanar') o.target = ed.world.terrain.baseHeight(ev.ground.x, ev.ground.z);
      ed.store.begin();
      active = true;
      at = ev.ground;
      return true;
    },
    move(ev) {
      if (!ev.ground) {
        ring.visible = false;
        return;
      }
      at = ev.ground;
      drawRing(ev.ground);
    },
    up() {
      active = false;
      commit();
    },
    onKey(e) {
      if (e.key === '[' || e.key === ']') {
        o.radius = Math.max(1, Math.min(80, o.radius * (e.key === ']' ? 1.2 : 1 / 1.2)));
        ed.refreshOptions?.();
        if (at) drawRing(at);
        return true;
      }
      return false;
    },
    options(el) {
      const modes = h('div', { class: 'seg' });
      for (const [k, l] of MODES)
        modes.append(
          h(
            'button',
            {
              class: k === o.mode ? 'active' : '',
              onclick: () => {
                o.mode = k;
                ed.refreshOptions?.();
              },
            },
            l,
          ),
        );
      const range = (label: string, key: 'radius' | 'strength', min: number, max: number, step: number, unit: string) => {
        const out = h('output', {}, fmt(o[key], key === 'radius' ? 1 : 2) + unit);
        return h(
          'label',
          { class: 'field' },
          h('span', {}, label),
          h('input', {
            type: 'range',
            min,
            max,
            step,
            value: o[key],
            oninput: (e: Event) => {
              o[key] = Number((e.target as HTMLInputElement).value);
              out.textContent = fmt(o[key], key === 'radius' ? 1 : 2) + unit;
            },
          }),
          out,
        );
      };
      el.append(modes, range('Radio', 'radius', 1, 80, 0.5, ' m'), range('Intensidad', 'strength', 0.05, 2, 0.05, ''));
      el.append(
        h(
          'label',
          { class: 'field' },
          h('span', {}, 'Cota objetivo'),
          h('input', {
            type: 'number',
            step: 0.1,
            value: o.target.toFixed(2),
            onchange: (e: Event) => (o.target = Number((e.target as HTMLInputElement).value)),
          }),
          h('output', {}, 'm'),
        ),
      );
      el.append(h('div', { class: 'cat-title' }, 'Relieve completo'));
      const gen = (label: string, fn: (x: number, z: number) => number) =>
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              ed.store.begin();
              const t = ed.store.project.terrain;
              const n = t.segs + 1;
              const half = t.size / 2;
              const step = t.size / t.segs;
              for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) t.base[j * n + i] = fn(-half + i * step, -half + j * step);
              ed.store.end();
              ed.store.notify({ type: 'terrain' });
            },
          },
          label,
        );
      const vn = valueNoise2D(7);
      el.append(
        h(
          'div',
          { class: 'row wrap' },
          gen('Llano', () => 0),
          gen('Ondulado suave', (x, z) => vn(x / 80, z / 80) * 6 + vn(x / 25, z / 25) * 1.2),
          gen('Ladera', (x, z) => -x * 0.08 + vn(x / 60, z / 60) * 4),
        ),
      );
      el.append(h('p', { class: 'muted' }, 'Las carreteras y ríos excavan o rellenan el terreno automáticamente (desmontes, terraplenes y cauces).'));
    },
  };
}
