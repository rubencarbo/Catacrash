import * as THREE from 'three';
import type { Editor } from '../editor';
import type { VehicleEntity } from '../model/types';
import { openFitDialog } from './fitDialog';
import { alignToRoad, giveMotion, rotateBy } from './actions';
import { clear, h } from './dom';

const I = (d: string) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const IC = {
  left: I('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>'),
  right: I('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>'),
  flip: I('<path d="M7 4v16M7 4l-3 3M7 4l3 3M17 20V4M17 20l-3-3M17 20l3-3"/>'),
  align: I('<path d="M5 3v18M19 3v18M12 6v3M12 12v3M12 18v2"/>'),
  go: I('<path d="M5 19c4-1 6-4 7-7s3-6 7-7"/><path d="M15 5h4v4"/>'),
  fit: I('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  copy: I('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>'),
  del: I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),
};

/**
 * Barra flotante junto al vehículo u objeto seleccionado con las acciones más habituales:
 * girar, invertir el sentido, alinear con la vía, darle movimiento, ajustar, duplicar y borrar.
 */
export function buildQuickBar(ed: Editor, host: HTMLElement) {
  const el = h('div', { class: 'quick-bar' });
  // icono de rotación: se arrastra alrededor del vehículo para girarlo
  const rot = h('button', {
    class: 'rot-handle',
    title: 'Girar: mantén pulsado y arrastra alrededor (se ajusta a la vía; Mayús: pasos de 15°)',
    html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/></svg>',
    onpointerdown: (e: Event) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0) return;
      pe.preventDefault();
      pe.stopPropagation();
      ed.beginRotate(pe);
    },
  });
  host.append(el, rot);
  let shownFor = '';
  const render = () => {
    clear(el);
    const sel = ed.store.selection;
    const e = sel ? ed.store.get(sel.id) : undefined;
    shownFor = '';
    if (!e || (e.kind !== 'vehicle' && e.kind !== 'prop') || (ed.tool.id !== 'select' && ed.tool.id !== 'vehicle')) {
      el.style.display = 'none';
      rot.style.display = 'none';
      return;
    }
    rot.style.display = 'grid';
    shownFor = e.id;
    const b = (icon: string, title: string, fn: () => void, label?: string) => h('button', { class: 'qb-btn' + (label ? ' text' : ''), title, html: icon + (label ? `<span>${label}</span>` : ''), onclick: fn });
    el.append(
      h('span', { class: 'qb-name' }, e.kind === 'vehicle' ? (e as VehicleEntity).label || e.name : e.name),
      b(IC.left, 'Girar 15° a la izquierda', () => rotateBy(ed, e.id, -15)),
      b(IC.right, 'Girar 15° a la derecha', () => rotateBy(ed, e.id, 15)),
    );
    if (e.kind === 'vehicle') {
      const v = e as VehicleEntity;
      el.append(b(IC.flip, 'Invertir el sentido de la marcha (180°)', () => rotateBy(ed, e.id, 180)), b(IC.align, 'Alinear con la carretera', () => alignToRoad(ed, e.id)));
      if (!v.drive) el.append(b(IC.go, 'Darle movimiento: ruta por su carril y velocidad (luego la ajustas)', () => giveMotion(ed, v), 'Mover'));
      else el.append(b(IC.fit, 'Averiguar velocidad y maniobra a partir de lo observado', () => openFitDialog(ed, e.id), 'Ajustar'));
    }
    el.append(
      b(IC.copy, 'Duplicar (Ctrl+D)', () => ed.duplicateSelection()),
      h('button', { class: 'qb-btn danger', title: 'Borrar (Supr)', html: IC.del, onclick: () => ed.deleteSelection() }),
    );
    el.style.display = 'flex';
  };
  ed.store.onSelect(render);
  ed.store.on(() => render());
  ed.onToolChange(() => render());
  render();
  const v = new THREE.Vector3();
  ed.vp.onFrame(() => {
    if (!shownFor) return;
    const obj = ed.world.objects.get(shownFor);
    if (!obj || !obj.visible) {
      el.style.visibility = 'hidden';
      rot.style.visibility = 'hidden';
      return;
    }
    const box = new THREE.Box3().setFromObject(obj);
    const r = ed.vp.renderer.domElement.getBoundingClientRect();
    const toScreen = (p: THREE.Vector3) => {
      p.project(ed.vp.camera);
      return [((p.x + 1) / 2) * r.width, ((1 - p.y) / 2) * r.height, p.z] as const;
    };
    const [x, yTop, zc] = toScreen(v.set((box.min.x + box.max.x) / 2, box.max.y + 0.6, (box.min.z + box.max.z) / 2));
    const [, yBot] = toScreen(v.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2));
    // a un lado del vehículo que no tape la flecha de giro del dial
    const knob = ed.dial.knobWorld();
    const ks = knob ? toScreen(knob.clone()) : null;
    const ky = ks ? ks[1] : yTop - 100;
    const cy = (yTop + yBot) / 2;
    const below = ky < cy;
    const off = zc > 1 || x < 0 || x > r.width || cy < 0 || cy > r.height;
    el.style.visibility = off ? 'hidden' : 'visible';
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    const yb = Math.max(yBot, yTop, ky) + 24;
    const ya = Math.min(yTop, yBot, ky) - hgt - 24;
    el.style.left = `${Math.min(r.width - w - 8, Math.max(8, x - w / 2))}px`;
    el.style.top = `${Math.min(r.height - hgt - 8, Math.max(8, below ? yb : ya))}px`;
    // icono de rotación más allá de la punta de la flecha del dial
    if (ks) {
      const [kx, ky2] = ks;
      const [cx2, cy2] = toScreen(obj.position.clone());
      const dx = kx - cx2;
      const dy = ky2 - cy2;
      const d = Math.hypot(dx, dy) || 1;
      rot.style.visibility = off ? 'hidden' : 'visible';
      rot.style.left = `${kx + (dx / d) * 30 - 17}px`;
      rot.style.top = `${ky2 + (dy / d) * 30 - 17}px`;
    } else rot.style.visibility = 'hidden';
  });
}
