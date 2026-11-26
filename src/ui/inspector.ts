import type { Editor } from '../editor';
import { BAND_DEFAULT_WIDTH, BAND_LABELS, LINE_LABELS, LINEAR_DEFS, LINEAR_FIELDS, ROAD_PRESETS } from '../model/defaults';
import type { FieldDef } from '../model/fields';
import type { Change } from '../model/store';
import type { AreaMaterial, Band, BandType, Entity, LineType, LinearType, ParamValue, RoadEntity, RoundaboutEntity } from '../model/types';
import { AREA_LABELS } from '../scene/area';
import { renderVehicleInspector } from './vehicleInspector';
import { CATALOG } from '../scene/props';
import { clear, fmt, h } from './dom';
import { ICON } from './icons';

const BAND_COLORS: Record<BandType, string> = {
  carril: '#4b4d52',
  arcen: '#5e6066',
  carril_bici: '#9a4a3d',
  aparcamiento: '#686a70',
  acera: '#b8b0a2',
  cuneta: '#7d6447',
  tierra: '#9c8f74',
  hierba: '#5f7a3b',
};

export class Inspector {
  constructor(
    private el: HTMLElement,
    private ed: Editor,
  ) {
    ed.store.onSelect(() => this.render());
    ed.store.on((c: Change) => {
      const sel = ed.store.selection;
      if (c.type === 'all' || c.type === 'entities') return this.render();
      if (c.type === 'entity' && sel && c.id === sel.id && !this.el.contains(document.activeElement)) this.render();
    });
    ed.inspectorSync = () => {
      if (!this.el.contains(document.activeElement)) this.render();
    };
    this.render();
  }

  private change(e: Entity, fn: () => void) {
    this.ed.store.edit(fn, { type: 'entity', id: e.id });
  }

  // ---------- controles genéricos ----------
  private numberField(label: string, value: number, set: (v: number) => void, unit = 'm', step = 0.05, min?: number, max?: number) {
    return h(
      'label',
      { class: 'field' },
      h('span', {}, label),
      h('input', {
        type: 'number',
        step,
        min: min ?? '',
        max: max ?? '',
        value: Number(value.toFixed(3)),
        onchange: (ev: Event) => {
          const v = Number((ev.target as HTMLInputElement).value);
          if (Number.isFinite(v)) set(v);
        },
      }),
      h('output', {}, unit),
    );
  }

  private paramField(e: Entity, def: FieldDef, params: Record<string, ParamValue>, defaults: Record<string, ParamValue>) {
    const cur = params[def.key] ?? defaults[def.key];
    const set = (v: ParamValue) => this.change(e, () => (params[def.key] = v));
    switch (def.type) {
      case 'number':
        return this.numberField(def.label, Number(cur ?? 0), (v) => set(v), def.unit ?? '', def.step ?? 0.05, def.min, def.max);
      case 'select': {
        const s = h('select', { onchange: (ev: Event) => set((ev.target as HTMLSelectElement).value) });
        for (const [k, l] of def.options) s.append(h('option', { value: k, selected: k === cur }, l));
        return h('label', { class: 'field' }, h('span', {}, def.label), s);
      }
      case 'bool':
        return h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: cur === true, onchange: (ev: Event) => set((ev.target as HTMLInputElement).checked) }),
          def.label,
        );
      case 'text':
        return h(
          'label',
          { class: 'field' },
          h('span', {}, def.label),
          h('input', { type: 'text', value: String(cur ?? ''), onchange: (ev: Event) => set((ev.target as HTMLInputElement).value) }),
        );
      case 'color':
        return h(
          'label',
          { class: 'field' },
          h('span', {}, def.label),
          h('input', { type: 'color', value: String(cur ?? '#ffffff'), onchange: (ev: Event) => set((ev.target as HTMLInputElement).value) }),
        );
    }
  }

  // ---------- render ----------
  render() {
    const el = this.el;
    clear(el);
    const sel = this.ed.store.selection;
    const e = sel ? this.ed.store.get(sel.id) : undefined;
    if (!e) {
      el.append(
        h('div', { class: 'panel-title' }, 'Inspector'),
        h('p', { class: 'muted' }, 'Selecciona un elemento en la escena o en la lista para editar sus propiedades. Todas las medidas están en metros, a escala real.'),
      );
      return;
    }

    const head = h(
      'div',
      { class: 'insp-head' },
      h('input', {
        class: 'name',
        type: 'text',
        value: e.name,
        onchange: (ev: Event) => this.change(e, () => (e.name = (ev.target as HTMLInputElement).value)),
      }),
      h('button', { class: 'icon-btn', title: 'Encuadrar (F)', html: ICON.target, onclick: () => this.ed.focusSelection() }),
      h('button', { class: 'icon-btn', title: 'Duplicar (Ctrl+D)', html: ICON.copy, onclick: () => this.ed.duplicateSelection() }),
      h('button', {
        class: 'icon-btn danger',
        title: 'Eliminar (Supr)',
        html: ICON.trash,
        onclick: () => {
          this.ed.store.remove(e.id);
        },
      }),
    );
    el.append(head);

    if ('points' in e && sel?.point !== undefined && e.points[sel.point]) this.renderPoint(e, sel.point);

    switch (e.kind) {
      case 'road':
        this.renderRoad(e);
        break;
      case 'area': {
        const m = h('select', { onchange: (ev: Event) => this.change(e, () => (e.material = (ev.target as HTMLSelectElement).value as AreaMaterial)) });
        for (const [k, l] of Object.entries(AREA_LABELS)) m.append(h('option', { value: k, selected: k === e.material }, l));
        el.append(
          h('div', { class: 'panel-title' }, 'Área'),
          h('label', { class: 'field' }, h('span', {}, 'Material'), m),
          h(
            'div',
            { class: 'grid2' },
            this.numberField('Altura (bordillo)', e.raise, (v) => this.change(e, () => (e.raise = Math.max(0, v))), 'm', 0.05),
            this.numberField('Talud', e.talud, (v) => this.change(e, () => (e.talud = Math.max(0.2, v))), 'm', 0.5),
            this.numberField('Ángulo cebreado', e.angle, (v) => this.change(e, () => (e.angle = v)), '°', 5),
          ),
          h('p', { class: 'muted' }, `${e.points.length} vértices. Los que caen sobre una calzada toman su cota; selecciona un vértice para fijarla a mano.`),
        );
        break;
      }
      case 'roundabout': {
        const sel = (label: string, value: string, opts: [string, string][], set: (v: string) => void) => {
          const s2 = h('select', { onchange: (ev: Event) => this.change(e, () => set((ev.target as HTMLSelectElement).value)) });
          for (const [k, l] of opts) s2.append(h('option', { value: k, selected: k === value }, l));
          return h('label', { class: 'field' }, h('span', {}, label), s2);
        };
        const t = this.ed.world.terrain;
        el.append(
          h('div', { class: 'panel-title' }, 'Glorieta'),
          h(
            'div',
            { class: 'grid2' },
            this.numberField('Radio exterior', e.radius, (v) => this.change(e, () => (e.radius = Math.max(e.width + 1.5, v))), 'm', 0.5),
            this.numberField('Ancho calzada', e.width, (v) => this.change(e, () => (e.width = Math.max(3, v))), 'm', 0.25),
            this.numberField('Carriles', e.lanes, (v) => this.change(e, () => (e.lanes = Math.max(1, Math.min(4, Math.round(v))))), '', 1),
            this.numberField('Gorjal', e.apron, (v) => this.change(e, () => (e.apron = Math.max(0, v))), 'm', 0.25),
            this.numberField('Centro X', e.cx, (v) => this.change(e, () => (e.cx = v))),
            this.numberField('Centro Z', e.cz, (v) => this.change(e, () => (e.cz = v))),
          ),
          sel('Isleta central', e.island, [
            ['hierba', 'Ajardinada (montículo)'],
            ['tierra', 'Tierra'],
            ['pavimento', 'Pavimentada'],
          ], (v) => (e.island = v as RoundaboutEntity['island'])),
          sel('Borde exterior', e.outer, [
            ['arcen', 'Arcén'],
            ['acera', 'Acera con bordillo'],
            ['ninguno', 'Ninguno'],
          ], (v) => (e.outer = v as RoundaboutEntity['outer'])),
          e.outer !== 'ninguno' ? this.numberField('Ancho borde exterior', e.outerWidth, (v) => this.change(e, () => (e.outerWidth = Math.max(0.3, v)))) : '',
          this.numberField('Talud', e.talud, (v) => this.change(e, () => (e.talud = Math.max(0.5, v))), 'm', 0.5),
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: e.h !== null,
              onchange: (ev: Event) => this.change(e, () => (e.h = (ev.target as HTMLInputElement).checked ? Number(t.baseHeight(e.cx, e.cz).toFixed(2)) : null)),
            }),
            'Cota fija del centro',
          ),
          e.h !== null ? this.numberField('Cota', e.h, (v) => this.change(e, () => (e.h = v))) : '',
        );
        break;
      }
      case 'photo': {
        el.append(
          h('div', { class: 'panel-title' }, 'Foto de referencia'),
          h('button', { class: 'btn primary', onclick: () => this.ed.photoMatch?.(e.id) }, 'Ver desde aquí y coincidir'),
          h(
            'div',
            { class: 'grid2' },
            this.numberField('X', e.x, (v) => this.change(e, () => (e.x = v))),
            this.numberField('Z', e.z, (v) => this.change(e, () => (e.z = v))),
            this.numberField('Rumbo', e.heading, (v) => this.change(e, () => (e.heading = ((v % 360) + 360) % 360)), '°', 0.5),
            this.numberField('Inclinación', e.pitch, (v) => this.change(e, () => (e.pitch = v)), '°', 0.25),
            this.numberField('Giro', e.roll, (v) => this.change(e, () => (e.roll = v)), '°', 0.25),
            this.numberField('Altura cámara', e.height, (v) => this.change(e, () => (e.height = Math.max(0.2, v))), 'm', 0.05),
            e.mode !== 'esferica' ? this.numberField('Campo horiz.', e.hfov, (v) => this.change(e, () => (e.hfov = Math.max(5, Math.min(360, v)))), '°', 1) : null,
          ),
          h('p', { class: 'muted' }, e.mode === 'esferica' ? 'Foto 360°' : e.mode === 'cilindrica' ? 'Panorámica de móvil' : 'Foto normal'),
        );
        break;
      }
      case 'vehicle':
        renderVehicleInspector(el, this.ed, e, this.numberField.bind(this));
        break;
      case 'river':
        el.append(
          h('div', { class: 'panel-title' }, 'Río / cauce'),
          this.numberField('Ancho de lámina', e.width, (v) => this.change(e, () => (e.width = Math.max(0.5, v)))),
          this.numberField('Profundidad', e.depth, (v) => this.change(e, () => (e.depth = Math.max(0, v)))),
          this.numberField('Orillas (transición)', e.bank, (v) => this.change(e, () => (e.bank = Math.max(0.5, v)))),
          this.numberField('Nivel respecto al terreno', e.levelOffset, (v) => this.change(e, () => (e.levelOffset = v))),
          h('p', { class: 'muted' }, 'Con un punto seleccionado puedes fijar la cota exacta del agua en ese punto.'),
        );
        break;
      case 'linear': {
        const s = h('select', {
          onchange: (ev: Event) => {
            const t = (ev.target as HTMLSelectElement).value as LinearType;
            this.change(e, () => {
              e.type = t;
              e.params = { ...LINEAR_DEFS[t].defaults };
            });
          },
        });
        for (const [k, d] of Object.entries(LINEAR_DEFS)) s.append(h('option', { value: k, selected: k === e.type }, d.label));
        el.append(h('div', { class: 'panel-title' }, 'Elemento lineal'), h('label', { class: 'field' }, h('span', {}, 'Tipo'), s));
        for (const f of LINEAR_FIELDS[e.type]) el.append(this.paramField(e, f, e.params, LINEAR_DEFS[e.type].defaults));
        el.append(h('p', { class: 'muted' }, `${e.points.length} puntos. Arrastra los puntos blancos para insertar vértices.`));
        break;
      }
      case 'prop': {
        const def = CATALOG[e.type];
        el.append(
          h('div', { class: 'panel-title' }, def?.label ?? e.type),
          h(
            'div',
            { class: 'grid2' },
            this.numberField('X (este)', e.x, (v) => this.change(e, () => (e.x = v))),
            this.numberField('Z (sur)', e.z, (v) => this.change(e, () => (e.z = v))),
            this.numberField('Rumbo', e.rot, (v) => this.change(e, () => (e.rot = ((v % 360) + 360) % 360)), '°', 1),
            this.numberField('Elevación', e.dy, (v) => this.change(e, () => (e.dy = v))),
          ),
        );
        if (def) for (const f of def.fields) el.append(this.paramField(e, f, e.params, def.defaults));
        el.append(h('p', { class: 'muted' }, 'Arrastra las flechas para mover. G: mover · R: girar.'));
        break;
      }
      case 'overlay': {
        const op = h('output', {}, `${Math.round(e.opacity * 100)} %`);
        el.append(
          h('div', { class: 'panel-title' }, 'Calco'),
          h(
            'label',
            { class: 'field' },
            h('span', {}, 'Opacidad'),
            h('input', {
              type: 'range',
              min: 0,
              max: 1,
              step: 0.01,
              value: e.opacity,
              onpointerdown: () => this.ed.store.begin(),
              oninput: (ev: Event) => {
                e.opacity = Number((ev.target as HTMLInputElement).value);
                op.textContent = `${Math.round(e.opacity * 100)} %`;
                this.ed.store.notify({ type: 'entity', id: e.id });
              },
              onchange: () => this.ed.store.end(),
            }),
            op,
          ),
          h(
            'div',
            { class: 'grid2' },
            this.numberField('Ancho', e.width, (v) => this.change(e, () => (e.width = Math.max(0.5, v)))),
            this.numberField('Giro', e.rot, (v) => this.change(e, () => (e.rot = v)), '°', 0.5),
            this.numberField('Centro X', e.cx, (v) => this.change(e, () => (e.cx = v))),
            this.numberField('Centro Z', e.cz, (v) => this.change(e, () => (e.cz = v))),
          ),
          h(
            'label',
            { class: 'check' },
            h('input', { type: 'checkbox', checked: e.onRoads, onchange: (ev: Event) => this.change(e, () => (e.onRoads = (ev.target as HTMLInputElement).checked)) }),
            'Mostrar también sobre las carreteras',
          ),
          h('p', { class: 'muted' }, `Alto: ${fmt(e.width * e.aspect)} m. Máximo 3 calcos visibles a la vez.`),
        );
        break;
      }
    }
  }

  private renderPoint(e: Entity & { points: { x: number; z: number; h: number | null }[] }, i: number) {
    const p = e.points[i];
    const fixed = p.h !== null;
    const t = this.ed.world.terrain;
    const cur = p.h ?? t.baseHeight(p.x, p.z);
    const box = h(
      'div',
      { class: 'point-box' },
      h('div', { class: 'panel-title' }, `Punto ${i + 1} de ${e.points.length}`),
      h(
        'div',
        { class: 'grid2' },
        this.numberField('X', p.x, (v) => this.change(e, () => (p.x = v))),
        this.numberField('Z', p.z, (v) => this.change(e, () => (p.z = v))),
      ),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: fixed,
          onchange: (ev: Event) => this.change(e, () => (p.h = (ev.target as HTMLInputElement).checked ? Number(cur.toFixed(2)) : null)),
        }),
        'Cota fija (rampas, puentes, terraplenes)',
      ),
      fixed ? this.numberField('Cota', p.h!, (v) => this.change(e, () => (p.h = v))) : h('p', { class: 'muted' }, `Sigue el terreno: ${fmt(cur)} m`),
      e.points.length > ('kind' in e && e.kind === 'area' ? 3 : 2)
        ? h('button', { class: 'btn', onclick: () => this.ed.deleteSelection() }, 'Quitar este punto')
        : null,
    );
    this.el.append(box);
  }

  // ---------- carretera ----------
  private renderRoad(e: RoadEntity) {
    const el = this.el;
    const P = e.profile;
    const prio = h('select', { onchange: (ev: Event) => this.change(e, () => (e.priority = Number((ev.target as HTMLSelectElement).value))) });
    for (const [v, l] of [
      ['2', 'Principal'],
      ['1', 'Normal'],
      ['0', 'Secundaria'],
    ])
      prio.append(h('option', { value: v, selected: Number(v) === (e.priority ?? 1) }, l));
    el.append(
      h('label', { class: 'field' }, h('span', {}, 'Jerarquía en cruces'), prio),
      h('div', { class: 'panel-title' }, 'Sección transversal'),
    );

    // Diagrama de la sección
    const bar = h('div', { class: 'xsec' });
    const all: { b: Band; side: number }[] = [...[...P.left].reverse().map((b) => ({ b, side: -1 })), ...P.right.map((b) => ({ b, side: 1 }))];
    const total = all.reduce((s, x) => s + x.b.width, 0) || 1;
    all.forEach(({ b }, i) => {
      const seg = h('div', { class: 'xsec-band', style: `flex:${b.width};background:${BAND_COLORS[b.type]}`, title: `${BAND_LABELS[b.type]} · ${fmt(b.width)} m` });
      if (i === P.left.length) seg.classList.add('axis');
      bar.append(seg);
    });
    el.append(bar, h('div', { class: 'xsec-legend' }, h('span', {}, 'izquierda'), h('span', {}, `${fmt(total)} m`), h('span', {}, 'derecha')));

    const preset = h('select', {
      onchange: (ev: Event) => {
        const k = (ev.target as HTMLSelectElement).value;
        if (ROAD_PRESETS[k]) this.change(e, () => (e.profile = ROAD_PRESETS[k].make()));
      },
    });
    preset.append(h('option', { value: '' }, 'Aplicar sección tipo…'));
    for (const [k, p] of Object.entries(ROAD_PRESETS)) preset.append(h('option', { value: k }, p.label));
    el.append(h('label', { class: 'field wide' }, preset));

    const lineSel = (value: LineType, set: (v: LineType) => void) => {
      const s = h('select', { onchange: (ev: Event) => set((ev.target as HTMLSelectElement).value as LineType) });
      for (const [k, l] of Object.entries(LINE_LABELS)) s.append(h('option', { value: k, selected: k === value }, l));
      return s;
    };
    el.append(h('label', { class: 'field' }, h('span', {}, 'Marca en el eje'), lineSel(P.center, (v) => this.change(e, () => (P.center = v)))));

    for (const side of ['left', 'right'] as const) {
      const list = P[side];
      el.append(h('div', { class: 'cat-title' }, side === 'left' ? 'Lado izquierdo (del eje hacia fuera)' : 'Lado derecho (del eje hacia fuera)'));
      list.forEach((b, i) => {
        const type = h('select', { onchange: (ev: Event) => this.change(e, () => (b.type = (ev.target as HTMLSelectElement).value as BandType)) });
        for (const [k, l] of Object.entries(BAND_LABELS)) type.append(h('option', { value: k, selected: k === b.type }, l));
        el.append(
          h(
            'div',
            { class: 'band-row' },
            h('span', { class: 'swatch', style: `background:${BAND_COLORS[b.type]}` }),
            type,
            h('input', {
              type: 'number',
              step: 0.05,
              min: 0.1,
              value: b.width,
              title: 'Ancho (m)',
              onchange: (ev: Event) => this.change(e, () => (b.width = Math.max(0.1, Number((ev.target as HTMLInputElement).value)))),
            }),
            lineSel(b.line, (v) => this.change(e, () => (b.line = v))),
            h('button', {
              class: 'icon-btn small',
              title: 'Quitar banda',
              html: ICON.trash,
              onclick: () => this.change(e, () => list.splice(i, 1)),
            }),
          ),
        );
      });
      el.append(
        h(
          'button',
          {
            class: 'btn small',
            onclick: () => this.change(e, () => list.push({ type: 'arcen', width: BAND_DEFAULT_WIDTH.arcen, line: 'ninguna' })),
          },
          '+ Añadir banda',
        ),
      );
    }

    const firme = h('select', { onchange: (ev: Event) => this.change(e, () => (P.firme = (ev.target as HTMLSelectElement).value as RoadEntity['profile']['firme'])) });
    for (const [k, l] of [
      ['nuevo', 'Nuevo (oscuro)'],
      ['normal', 'Normal'],
      ['desgastado', 'Desgastado'],
    ])
      firme.append(h('option', { value: k, selected: k === P.firme }, l));

    el.append(
      h('div', { class: 'cat-title' }, 'Geometría'),
      h(
        'div',
        { class: 'grid2' },
        this.numberField('Bombeo', P.bombeo, (v) => this.change(e, () => (P.bombeo = v)), '%', 0.5),
        this.numberField('Peralte', P.peralte, (v) => this.change(e, () => (P.peralte = v)), '%', 0.5),
        this.numberField('Talud', P.talud, (v) => this.change(e, () => (P.talud = Math.max(0.5, v))), 'm', 0.5),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Firme'), firme),
      h(
        'button',
        {
          class: 'btn',
          onclick: () =>
            this.change(e, () => {
              e.points.reverse();
              const l = P.left;
              P.left = P.right;
              P.right = l;
              P.peralte = -P.peralte;
            }),
        },
        'Invertir sentido del trazado',
      ),
      h('p', { class: 'muted' }, 'Peralte positivo: la calzada sube hacia la derecha. Selecciona un punto para fijar su cota (rampas, puentes, badenes).'),
    );
  }
}
