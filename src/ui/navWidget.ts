import * as THREE from 'three';
import type { Editor } from '../editor';
import { h, toast } from './dom';

const I = (d: string) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICONS = {
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  minus: I('<path d="M5 12h14"/>'),
  rotL: I('<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>'),
  rotR: I('<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v4h-4"/>'),
  all: I('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  mouse: I('<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 7v3"/>'),
};

/**
 * Panel de navegación en la esquina del visor: brújula (clic = norte arriba), acercar/alejar,
 * girar, planta ↔ 3D, ver todo y estilo de ratón. Pensado para manejar la cámara solo con clics.
 */
export function buildNavWidget(ed: Editor, host: HTMLElement) {
  const vp = ed.vp;
  const compass = h('button', {
    class: 'nav-compass',
    title: 'Brújula: clic para poner el norte arriba',
    html: '<svg viewBox="0 0 44 44"><circle cx="22" cy="22" r="20" fill="none" stroke="currentColor" stroke-opacity=".25"/><g class="needle"><path d="M22 5l6 17h-12z" fill="#ef5350"/><path d="M22 39l6-17h-12z" fill="#9aa1a8"/></g><text x="22" y="14" text-anchor="middle" font-size="7.5" font-weight="700" fill="#fff" class="n">N</text></svg>',
    onclick: () => vp.northUp(),
  });
  const tilt = h('button', { class: 'nav-btn wide', title: 'Cambiar entre vista en planta y vista 3D (P)', onclick: () => (vp.isTop ? vp.view3d() : vp.topView()) }, '3D');
  const btn = (html: string, title: string, fn: () => void) => h('button', { class: 'nav-btn', title, html, onclick: fn });
  const mouseBtn = h('button', {
    class: 'nav-btn',
    html: ICONS.mouse,
    onclick: () => {
      vp.setMouseStyle(vp.mouseStyle === 'mapa' ? '3d' : 'mapa');
      updMouse();
      ed.refreshOptions?.();
      toast(
        vp.mouseStyle === 'mapa'
          ? 'Ratón tipo mapa: arrastrar con el botón izquierdo desplaza, con el derecho gira; la rueda acerca.'
          : 'Ratón tipo 3D: arrastrar con el botón izquierdo gira, con el derecho desplaza; la rueda acerca.',
      );
    },
  });
  const updMouse = () =>
    (mouseBtn.title =
      vp.mouseStyle === 'mapa'
        ? 'Ratón tipo mapa (izquierdo: desplazar · derecho: girar · rueda: acercar). Clic para cambiar a tipo 3D'
        : 'Ratón tipo 3D (izquierdo: girar · derecho: desplazar · rueda: acercar). Clic para cambiar a tipo mapa');
  updMouse();
  const el = h(
    'div',
    { class: 'nav-widget' },
    compass,
    h(
      'div',
      { class: 'nav-col' },
      btn(ICONS.plus, 'Acercar (+)', () => vp.zoomBy(0.65)),
      btn(ICONS.minus, 'Alejar (−)', () => vp.zoomBy(1.5)),
    ),
    h('div', { class: 'nav-col' }, btn(ICONS.rotL, 'Girar la vista a la izquierda (Q)', () => vp.rotateBy(-45)), btn(ICONS.rotR, 'Girar la vista a la derecha (E)', () => vp.rotateBy(45))),
    h('div', { class: 'nav-col' }, tilt, btn(ICONS.all, 'Ver todo el escenario', () => ed.frameAll())),
    mouseBtn,
  );
  host.append(el);
  const needle = el.querySelector('.needle') as SVGGElement;
  const dir = new THREE.Vector3();
  vp.onFrame(() => {
    vp.camera.getWorldDirection(dir);
    // en planta, la dirección de mirada es vertical: usar el «arriba» de la cámara
    if (Math.abs(dir.y) > 0.98) dir.set(0, 1, 0).applyQuaternion(vp.camera.quaternion);
    const ang = Math.atan2(dir.x, -dir.z);
    needle.setAttribute('transform', `rotate(${(-ang * 180) / Math.PI} 22 22)`);
    const top = vp.isTop;
    if (tilt.textContent !== (top ? '3D' : 'Planta')) tilt.textContent = top ? '3D' : 'Planta';
  });
  return el;
}
