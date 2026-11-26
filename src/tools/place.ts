import * as THREE from 'three';
import type { Editor, Tool } from '../editor';
import { newId } from '../model/store';
import type { PropEntity } from '../model/types';
import { buildProp, CATALOG, CATEGORIES } from '../scene/props';
import { h } from '../ui/dom';
import { ICON } from '../ui/icons';

/** Colocación de objetos del catálogo con previsualización. */
export function placeTool(ed: Editor): Tool {
  let type = 'arbol';
  let rot = 0;
  let ghost: THREE.Object3D | null = null;
  let lastPlaced: string | null = null;
  let optionsEl: HTMLElement | null = null;

  const makeGhost = () => {
    if (ghost) ed.vp.scene.remove(ghost);
    ghost = buildProp(type, {}, 12345);
    ghost.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = false;
        const ghostOf = (mm: THREE.Material) => {
          const c = mm.clone();
          c.transparent = true;
          c.opacity = 0.55;
          c.depthWrite = false;
          return c;
        };
        m.material = Array.isArray(m.material) ? m.material.map(ghostOf) : ghostOf(m.material);
      }
    });
    ghost.visible = false;
    ed.vp.scene.add(ghost);
  };

  const renderOptions = () => {
    if (!optionsEl) return;
    const el = optionsEl;
    el.innerHTML = '';
    for (const cat of CATEGORIES) {
      el.append(h('div', { class: 'cat-title' }, cat));
      const grid = h('div', { class: 'catalog' });
      for (const [k, d] of Object.entries(CATALOG)) {
        if (d.category !== cat) continue;
        grid.append(
          h(
            'button',
            {
              class: 'cat-item' + (k === type ? ' active' : ''),
              onclick: () => {
                type = k;
                makeGhost();
                renderOptions();
              },
            },
            d.label,
          ),
        );
      }
      el.append(grid);
    }
    el.append(h('p', { class: 'muted' }, 'Clic en la escena para colocar. Q/E: girar 15° · Esc: terminar. Las medidas se ajustan después en el inspector.'));
  };

  return {
    id: 'props',
    label: 'Colocar objetos',
    icon: ICON.props,
    key: 'o',
    hint: 'Clic: colocar · Q/E: girar · Esc: terminar',
    activate() {
      makeGhost();
    },
    deactivate() {
      if (ghost) ed.vp.scene.remove(ghost);
      ghost = null;
      if (lastPlaced) ed.select(lastPlaced);
      lastPlaced = null;
    },
    move(ev) {
      if (!ghost) return;
      if (!ev.ground) {
        ghost.visible = false;
        return;
      }
      ghost.visible = true;
      const surf = CATALOG[type]?.onSurface;
      ghost.position.set(ev.ground.x, surf ? ev.ground.y : ed.world.terrain.height(ev.ground.x, ev.ground.z), ev.ground.z);
      ghost.rotation.y = (-rot * Math.PI) / 180;
    },
    click(ev) {
      if (!ev.ground) return;
      const def = CATALOG[type];
      const count = ed.store.project.entities.filter((e) => e.kind === 'prop' && e.type === type).length + 1;
      const e: PropEntity = {
        id: newId('p'),
        kind: 'prop',
        type,
        name: `${def.label} ${count}`,
        x: ev.ground.x,
        z: ev.ground.z,
        rot,
        dy: 0,
        params: { ...def.defaults },
      };
      ed.store.add(e);
      lastPlaced = e.id;
    },
    onKey(e) {
      const k = e.key.toLowerCase();
      if (k === 'q' || k === 'e') {
        rot = (rot + (k === 'e' ? 15 : -15) + 360) % 360;
        if (ghost) ghost.rotation.y = (-rot * Math.PI) / 180;
        return true;
      }
      return false;
    },
    options(el) {
      optionsEl = el;
      renderOptions();
    },
  };
}
