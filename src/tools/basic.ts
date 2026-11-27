import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Editor, Tool, ToolEvent } from '../editor';
import { LINEAR_DEFS, ROAD_PRESETS } from '../model/defaults';
import { newId } from '../model/store';
import type { AreaMaterial, CtrlPoint, Entity, LinearType, RiverEntity } from '../model/types';
import { AREA_LABELS } from '../scene/area';
import { h, fmt } from '../ui/dom';
import { ICON } from '../ui/icons';

/** Busca la entidad bajo el puntero. */
export function pickEntity(ed: Editor, ev: ToolEvent): string | null {
  const hits = ev.ray.intersectObjects(ed.world.pickables(), true);
  for (const hit of hits) {
    let o: THREE.Object3D | null = hit.object;
    while (o && !o.userData.entityId) o = o.parent;
    if (o?.userData.entityId) return o.userData.entityId as string;
  }
  // Calcos: por posición sobre el terreno
  if (ev.ground) {
    const g = ev.ground;
    const overlays = ed.store.project.entities.filter((e) => e.kind === 'overlay' && !e.hidden);
    for (const o of overlays.reverse()) {
      if (o.kind !== 'overlay') continue;
      const c = Math.cos((o.rot * Math.PI) / 180);
      const s = Math.sin((o.rot * Math.PI) / 180);
      const dx = g.x - o.cx;
      const dz = g.z - o.cz;
      const lx = dx * c + dz * s;
      const lz = -dx * s + dz * c;
      if (Math.abs(lx) <= o.width / 2 && Math.abs(lz) <= (o.width * o.aspect) / 2 && ed.tool.id === 'overlay') return o.id;
    }
  }
  return null;
}

export function selectTool(ed: Editor): Tool {
  return {
    id: 'select',
    label: 'Seleccionar y editar',
    icon: ICON.select,
    key: 'v',
    handles: true,
    hint: 'Clic: seleccionar · Arrastrar un vehículo u objeto: moverlo · Flecha naranja: girarlo · Puntos naranjas: mover · Puntos blancos: insertar · Doble clic: ir ahí · Supr: borrar',
    click(ev) {
      ed.select(pickEntity(ed, ev));
    },
  };
}

// ---------------- Dibujo de trazados ----------------

type DrawKind = 'road' | 'river' | 'linear' | 'area';

export function drawTool(ed: Editor, kind: DrawKind): Tool {
  let current: string | null = null;
  const previewGeo = new THREE.BufferGeometry();
  const preview = new THREE.Line(previewGeo, new THREE.LineDashedMaterial({ color: 0xffb020, dashSize: 0.6, gapSize: 0.4, depthTest: false }));
  preview.renderOrder = 11;
  preview.visible = false;
  ed.vp.scene.add(preview);

  const opts = { preset: 'convencional', linear: 'muro' as LinearType, material: 'asfalto' as AreaMaterial, raise: 0 };
  const counters: Record<string, number> = {};

  const finish = () => {
    preview.visible = false;
    const id = current;
    current = null;
    if (!id) return;
    const e = ed.store.get(id);
    if (e && 'points' in e && e.points.length < (e.kind === 'area' ? 3 : 2)) {
      ed.store.remove(id);
      return;
    }
    ed.setTool('select');
    ed.select(id);
  };

  const meta = {
    road: { label: 'Dibujar carretera', icon: ICON.road, key: 'c' },
    river: { label: 'Dibujar río / cauce', icon: ICON.river, key: 'a' },
    linear: { label: 'Muros, vallas, guardarraíles, tendidos…', icon: ICON.linear, key: 'l' },
    area: { label: 'Áreas: ensanches, isletas, explanadas', icon: ICON.area, key: 'b' },
  }[kind];

  const makeEntity = (p: CtrlPoint): Entity => {
    const n = (counters[kind] = (counters[kind] ?? ed.store.project.entities.filter((e) => e.kind === kind).length) + 1);
    if (kind === 'road')
      return { id: newId('r'), kind: 'road', name: `Carretera ${n}`, points: [p], profile: ROAD_PRESETS[opts.preset].make() };
    if (kind === 'area')
      return {
        id: newId('a'),
        kind: 'area',
        name: `${opts.raise > 0 ? 'Isleta' : AREA_LABELS[opts.material]} ${n}`,
        points: [p],
        material: opts.material,
        raise: opts.raise,
        talud: 1.5,
        angle: 45,
      };
    if (kind === 'river')
      return { id: newId('w'), kind: 'river', name: `Río ${n}`, points: [p], width: 6, depth: 1.2, bank: 6, levelOffset: -1 } as RiverEntity;
    const def = LINEAR_DEFS[opts.linear];
    return { id: newId('l'), kind: 'linear', type: opts.linear, name: `${def.label} ${n}`, points: [p], params: { ...def.defaults } };
  };

  return {
    id: kind,
    ...meta,
    hint: 'Clic: añadir punto · Doble clic / Intro / clic derecho: terminar · Retroceso: quitar último punto · Esc: salir',
    activate() {
      current = null;
    },
    deactivate() {
      if (current) finish();
      preview.visible = false;
    },
    click(ev) {
      if (!ev.ground) return;
      const p: CtrlPoint = { x: ev.ground.x, z: ev.ground.z, h: null };
      if (!current) {
        const e = makeEntity(p);
        ed.store.add(e);
        current = e.id;
        ed.select(e.id);
        return;
      }
      const e = ed.store.get(current);
      if (!e || !('points' in e)) return;
      const last = e.points[e.points.length - 1];
      if (Math.hypot(last.x - p.x, last.z - p.z) < 0.3) return;
      ed.store.edit(() => e.points.push(p), { type: 'entity', id: e.id });
    },
    dblclick() {
      finish();
    },
    rightClick() {
      finish();
    },
    move(ev) {
      const e = current ? ed.store.get(current) : null;
      if (!e || !('points' in e) || !ev.ground) {
        preview.visible = false;
        return;
      }
      const last = e.points[e.points.length - 1];
      const t = ed.world.terrain;
      const a = new THREE.Vector3(last.x, t.height(last.x, last.z) + 0.3, last.z);
      const b = ev.ground.clone().setY(ev.ground.y + 0.3);
      previewGeo.setFromPoints([a, b]);
      preview.computeLineDistances();
      preview.visible = true;
      const d = a.distanceTo(b);
      ed.setHint?.(`Tramo: ${fmt(d)} m`);
    },
    onKey(e) {
      if (e.key === 'Enter') {
        finish();
        return true;
      }
      if (e.key === 'Escape') {
        finish();
        ed.setTool('select');
        return true;
      }
      if (e.key === 'Backspace' && current) {
        const ent = ed.store.get(current);
        if (ent && 'points' in ent && ent.points.length > 1) ed.store.edit(() => ent.points.pop(), { type: 'entity', id: ent.id });
        return true;
      }
      return false;
    },
    options(el) {
      if (kind === 'road') {
        const s = h('select', {
          onchange: (e: Event) => (opts.preset = (e.target as HTMLSelectElement).value),
        });
        for (const [k, p] of Object.entries(ROAD_PRESETS)) s.append(h('option', { value: k, selected: k === opts.preset }, p.label));
        el.append(h('label', { class: 'field' }, h('span', {}, 'Sección tipo'), s));
        el.append(
          h('p', { class: 'muted' }, 'Dibuja el eje de la vía. Después podrás editar carriles, arcenes, aceras, cunetas, marcas viales, peralte y taludes.'),
          h(
            'p',
            { class: 'muted' },
            'Cruces: termina la vía secundaria dentro de la principal. Se recorta sola, toma la cota de la principal y la línea de borde se interrumpe. Para los chaflanes usa la herramienta Áreas.',
          ),
        );
      } else if (kind === 'linear') {
        const s = h('select', {
          onchange: (e: Event) => (opts.linear = (e.target as HTMLSelectElement).value as LinearType),
        });
        for (const [k, d] of Object.entries(LINEAR_DEFS)) s.append(h('option', { value: k, selected: k === opts.linear }, d.label));
        el.append(h('label', { class: 'field' }, h('span', {}, 'Elemento'), s));
        el.append(h('p', { class: 'muted' }, 'Los elementos lineales se apoyan sobre el terreno y siguen sus desniveles. En los tendidos, cada punto es un poste.'));
      } else if (kind === 'area') {
        const m = h('select', { onchange: (e: Event) => (opts.material = (e.target as HTMLSelectElement).value as AreaMaterial) });
        for (const [k, l] of Object.entries(AREA_LABELS)) m.append(h('option', { value: k, selected: k === opts.material }, l));
        const r = h('select', { onchange: (e: Event) => (opts.raise = Number((e.target as HTMLSelectElement).value)) });
        for (const [v, l] of [
          ['0', 'Enrasada con la calzada'],
          ['0.15', 'Elevada con bordillo (15 cm)'],
          ['0.3', 'Elevada (30 cm)'],
        ])
          r.append(h('option', { value: v, selected: Number(v) === opts.raise }, l));
        el.append(
          h('label', { class: 'field' }, h('span', {}, 'Material'), m),
          h('label', { class: 'field' }, h('span', {}, 'Altura'), r),
          h(
            'p',
            { class: 'muted' },
            'Dibuja el contorno con clics (mínimo 3 puntos). Los vértices que caen sobre una calzada toman su cota, así el ensanche de un cruce enlaza con las vías. Útil para chaflanes de cruces, isletas, cebreados, aparcamientos, explanadas o plazas.',
          ),
        );
      } else {
        el.append(h('p', { class: 'muted' }, 'Dibuja el eje del cauce siguiendo el fondo del valle. El terreno se excava automáticamente y se crea la lámina de agua.'));
      }
    },
  };
}

// ---------------- Medición ----------------

export function measureTool(ed: Editor): Tool {
  const group = new THREE.Group();
  ed.vp.scene.add(group);
  let first: THREE.Vector3 | null = null;
  const lineMat = new THREE.LineBasicMaterial({ color: 0x29d3ff, depthTest: false });
  const dotGeo = new THREE.SphereGeometry(0.15, 10, 8);
  const dotMat = new THREE.MeshBasicMaterial({ color: 0x29d3ff, depthTest: false });
  const tmpGeo = new THREE.BufferGeometry();
  const tmp = new THREE.Line(tmpGeo, lineMat);
  tmp.renderOrder = 12;
  tmp.visible = false;
  ed.vp.scene.add(tmp);

  const dot = (p: THREE.Vector3) => {
    const m = new THREE.Mesh(dotGeo, dotMat);
    m.position.copy(p);
    m.renderOrder = 12;
    group.add(m);
  };
  const clearAll = () => {
    for (const c of [...group.children]) {
      group.remove(c);
      if (c instanceof CSS2DObject) c.element.remove();
    }
    first = null;
    tmp.visible = false;
  };
  const label = (a: THREE.Vector3, b: THREE.Vector3) => {
    const d3 = a.distanceTo(b);
    const dh = Math.hypot(b.x - a.x, b.z - a.z);
    const slope = dh > 0.01 ? ((b.y - a.y) / dh) * 100 : 0;
    return `${fmt(d3)} m · horiz. ${fmt(dh)} m · desnivel ${fmt(b.y - a.y)} m (${fmt(slope, 1)} %)`;
  };

  return {
    id: 'measure',
    label: 'Medir distancias',
    icon: ICON.measure,
    key: 'm',
    hint: 'Clic en dos puntos para medir · Esc: borrar medidas',
    deactivate() {
      first = null;
      tmp.visible = false;
    },
    click(ev) {
      if (!ev.ground) return;
      const p = ev.ground.clone();
      if (!first) {
        first = p;
        dot(p);
        return;
      }
      const a = first.clone().setY(first.y + 0.05);
      const b = p.clone().setY(p.y + 0.05);
      const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), lineMat);
      l.renderOrder = 12;
      group.add(l);
      dot(p);
      const div = h('div', { class: 'label measure' }, label(first, p));
      const lbl = new CSS2DObject(div);
      lbl.position.copy(a.clone().lerp(b, 0.5)).setY(Math.max(a.y, b.y) + 0.6);
      group.add(lbl);
      first = null;
      tmp.visible = false;
    },
    move(ev) {
      if (!first || !ev.ground) return;
      tmpGeo.setFromPoints([first, ev.ground]);
      tmp.visible = true;
      ed.setHint?.(label(first, ev.ground));
    },
    onKey(e) {
      if (e.key === 'Escape') {
        clearAll();
        return true;
      }
      return false;
    },
    options(el) {
      el.append(
        h('p', { class: 'muted' }, 'Mide sobre la calzada o el terreno. Útil para comprobar anchos de carril, distancias entre elementos o la escala de un calco.'),
        h('button', { class: 'btn', onclick: clearAll }, 'Borrar medidas'),
      );
    },
  };
}
