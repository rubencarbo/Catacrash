import type { Editor } from '../editor';
import { newId } from '../model/store';
import type { DamageSide, DamageZone, DriverEvent, RoadEntity, SpecKey, VehicleEntity, VehicleType } from '../model/types';
import { readImage } from '../tools/overlayTool';
import { specTitle } from '../tools/vehicleTool';
import { saveToLibrary } from '../vehicles/catalog';
import { respec, TYPICAL } from '../vehicles/spec';
import { fmt, h, toast } from './dom';
import { laneRoute } from '../physics/lane';
import { ICON } from './icons';

type NumberField = (label: string, value: number, set: (v: number) => void, unit?: string, step?: number, min?: number, max?: number) => HTMLElement;

const SRC_LABEL: Record<string, [string, string]> = {
  catalogo: ['C', 'Dato del catálogo'],
  ficha: ['F', 'Introducido o pegado de la ficha'],
  estimado: ['E', 'Estimado a partir del resto de datos'],
  generico: ['G', 'Valor típico del tipo de vehículo'],
};

const SIDE_LABEL: Record<DamageSide, string> = {
  frontal: 'Frontal',
  trasera: 'Trasera',
  izquierda: 'Lateral izquierdo',
  derecha: 'Lateral derecho',
  techo: 'Techo',
};

/** Inspector de un vehículo: identificación, ficha técnica con origen de cada dato, daños y fotos. */
export function renderVehicleInspector(el: HTMLElement, ed: Editor, e: VehicleEntity, numberField: NumberField) {
  const change = (fn: () => void) => ed.store.edit(fn, { type: 'entity', id: e.id });
  const sp = e.spec;

  // ---------- Identificación ----------
  el.append(
    h('div', { class: 'panel-title' }, specTitle(sp)),
    h(
      'div',
      { class: 'grid2' },
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Etiqueta'),
        h('input', { type: 'text', value: e.label, maxlength: 6, onchange: (ev: Event) => change(() => (e.label = (ev.target as HTMLInputElement).value)) }),
      ),
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Color'),
        h('input', { type: 'color', value: e.color, onchange: (ev: Event) => change(() => (e.color = (ev.target as HTMLInputElement).value)) }),
      ),
      sp.tipo !== 'peaton' && sp.tipo !== 'bicicleta' && sp.tipo !== 'patinete'
        ? h(
            'label',
            { class: 'field' },
            h('span', {}, 'Matrícula'),
            h('input', { type: 'text', value: e.plate, maxlength: 10, placeholder: '0000 XXX', onchange: (ev: Event) => change(() => (e.plate = (ev.target as HTMLInputElement).value.toUpperCase())) }),
          )
        : null,
      sp.tipo !== 'peaton' ? numberField('Ocupantes', e.occupants, (v) => change(() => (e.occupants = Math.max(0, Math.round(v)))), '', 1, 0, 90) : null,
      sp.tipo !== 'peaton' ? numberField('Carga', e.cargo, (v) => change(() => (e.cargo = Math.max(0, v))), 'kg', 10, 0) : null,
    ),
    h(
      'div',
      { class: 'grid2' },
      numberField('X (este)', e.x, (v) => change(() => (e.x = v))),
      numberField('Z (sur)', e.z, (v) => change(() => (e.z = v))),
      numberField('Rumbo', e.heading, (v) => change(() => (e.heading = ((v % 360) + 360) % 360)), '°', 1),
    ),
  );
  const mass = sp.masa + (sp.tipo === 'peaton' ? 0 : Math.max(0, e.occupants - 1) * 75 + e.cargo);
  el.append(h('p', { class: 'muted' }, `Masa total en el accidente: ${mass.toLocaleString('es-ES')} kg (en orden de marcha con conductor${e.occupants > 1 ? ` + ${e.occupants - 1} ocupante(s)` : ''}${e.cargo ? ' + carga' : ''}).`));

  // ---------- Ficha técnica ----------
  el.append(h('div', { class: 'cat-title' }, 'Ficha técnica'));
  const typeSel = h('select', {
    onchange: (ev: Event) =>
      change(() => {
        e.spec = respec({ ...sp, tipo: (ev.target as HTMLSelectElement).value as VehicleType });
      }),
  });
  for (const [k, t] of Object.entries(TYPICAL)) typeSel.append(h('option', { value: k, selected: k === sp.tipo }, t.label));
  el.append(
    h('label', { class: 'field' }, h('span', {}, 'Tipo'), typeSel),
    h(
      'div',
      { class: 'grid2' },
      ...(
        [
          ['marca', 'Marca'],
          ['modelo', 'Modelo'],
          ['version', 'Versión'],
        ] as ['marca' | 'modelo' | 'version', string][]
      ).map(([k, l]) =>
        h('label', { class: 'field' }, h('span', {}, l), h('input', { type: 'text', value: sp[k], onchange: (ev: Event) => change(() => (sp[k] = (ev.target as HTMLInputElement).value)) })),
      ),
      numberField('Año', sp.anio ?? 0, (v) => change(() => (sp.anio = v > 1900 ? Math.round(v) : null)), '', 1),
    ),
  );
  const row = (k: SpecKey, label: string, unit: string, step: number, scale = 1) => {
    const src = sp.origen[k] ?? 'estimado';
    const [badge, tip] = SRC_LABEL[src] ?? SRC_LABEL.estimado;
    const f = numberField(
      label,
      ((sp[k] as number) ?? 0) * scale,
      (v) => {
        // quitar el foco para que el inspector se redibuje con los valores recalculados
        (document.activeElement as HTMLElement | null)?.blur();
        change(() => {
          const cur = e.spec;
          (cur as unknown as Record<string, number>)[k] = v / scale;
          e.spec = respec(cur, k);
        });
      },
      unit,
      step,
    );
    f.classList.add('spec-field');
    f.prepend(h('span', { class: `src src-${src}`, title: tip }, badge));
    return f;
  };
  if (sp.tipo === 'peaton') {
    el.append(h('div', { class: 'grid2' }, row('H', 'Estatura', 'm', 0.01), row('masa', 'Masa', 'kg', 1)));
  } else {
    el.append(
      h(
        'div',
        { class: 'grid2' },
        row('L', 'Longitud', 'm', 0.01),
        row('W', 'Anchura', 'm', 0.01),
        row('H', 'Altura', 'm', 0.01),
        row('batalla', 'Batalla', 'm', 0.01),
        row('viaD', 'Vía delantera', 'm', 0.01),
        row('viaT', 'Vía trasera', 'm', 0.01),
        row('volD', 'Voladizo del.', 'm', 0.01),
        row('volT', 'Voladizo tras.', 'm', 0.01),
        row('masa', 'Masa (o. marcha)', 'kg', 5),
        row('rueda', 'Ø rueda', 'm', 0.01),
        row('cdgAltura', 'Altura CDG', 'm', 0.01),
        row('cdgEje', 'CDG tras eje del.', 'm', 0.01),
        row('inercia', 'Inercia guiñada', 'kg·m²', 10),
      ),
    );
    const tr = h('select', { onchange: (ev: Event) => change(() => (sp.traccion = (ev.target as HTMLSelectElement).value as typeof sp.traccion)) });
    for (const [k, l] of [
      ['delantera', 'Delantera'],
      ['trasera', 'Trasera'],
      ['total', 'Total (4×4)'],
    ])
      tr.append(h('option', { value: k, selected: k === sp.traccion }, l));
    el.append(h('label', { class: 'field' }, h('span', {}, 'Tracción'), tr));
  }
  el.append(
    h(
      'p',
      { class: 'muted legend' },
      ...(
        [
          ['catalogo', 'catálogo'],
          ['ficha', 'ficha'],
          ['estimado', 'estimado'],
          ['generico', 'genérico'],
        ] as [string, string][]
      ).map(([k, t]) => h('span', {}, h('span', { class: `src src-${k}` }, SRC_LABEL[k][0]), ` ${t}`)),
    ),
  );
  if (sp.url) el.append(h('p', { class: 'muted' }, 'Fuente: ', h('a', { href: sp.url, target: '_blank', rel: 'noopener' }, sp.url.replace(/^https?:\/\//, '').slice(0, 60))));
  el.append(
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn', onclick: () => ed.vehicleChangeSpec?.(e.id) }, 'Cambiar modelo / pegar ficha…'),
      h(
        'button',
        {
          class: 'btn',
          onclick: async () => {
            await saveToLibrary(specTitle(e.spec), e.spec);
            toast(`Guardado en tu biblioteca: ${specTitle(e.spec)}`);
          },
        },
        'Guardar en mi biblioteca',
      ),
    ),
  );

  renderDrive(el, ed, e);
  if (sp.tipo !== 'peaton') renderDamage(el, ed, e, numberField);
  renderPhotos(el, ed, e);
}

// ---------------- Daños ----------------

function renderDamage(el: HTMLElement, ed: Editor, e: VehicleEntity, numberField: NumberField) {
  const change = (fn: () => void) => ed.store.edit(fn, { type: 'entity', id: e.id });
  const sp = e.spec;
  el.append(h('div', { class: 'cat-title' }, 'Daños'));
  // Silueta en planta: frontal arriba. Clic en un borde → nueva zona centrada ahí.
  const VW = 150;
  const k = Math.min(VW / sp.W, 220 / sp.L);
  const w = sp.W * k;
  const l = sp.L * k;
  const ox = 30;
  const oy = 20;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w + 60} ${l + 40}`);
  svg.setAttribute('class', 'damage-svg');
  const add = (tag: string, attrs: Record<string, string | number>) => {
    const n = document.createElementNS(ns, tag);
    for (const [a, v] of Object.entries(attrs)) n.setAttribute(a, String(v));
    svg.appendChild(n);
    return n;
  };
  add('rect', { x: ox, y: oy, width: w, height: l, rx: Math.min(w, l) * 0.12, class: 'body' });
  add('text', { x: ox + w / 2, y: oy - 6, 'text-anchor': 'middle', class: 'lbl' }).textContent = 'FRONTAL';
  add('text', { x: ox + w / 2, y: oy + l + 15, 'text-anchor': 'middle', class: 'lbl' }).textContent = 'TRASERA';
  add('text', { x: ox - 8, y: oy + l / 2, 'text-anchor': 'middle', class: 'lbl', transform: `rotate(-90 ${ox - 8} ${oy + l / 2})` }).textContent = 'IZQ.';
  add('text', { x: ox + w + 12, y: oy + l / 2, 'text-anchor': 'middle', class: 'lbl', transform: `rotate(90 ${ox + w + 12} ${oy + l / 2})` }).textContent = 'DER.';
  // ejes
  for (const s of [sp.volD, sp.L - sp.volT]) add('line', { x1: ox + 4, x2: ox + w - 4, y1: oy + s * k, y2: oy + s * k, class: 'axle' });
  for (const z of e.damage) {
    const dpx = Math.max(3, z.depth * k);
    let r: Record<string, number>;
    if (z.side === 'frontal') r = { x: ox + z.from * w, y: oy, width: (z.to - z.from) * w, height: dpx };
    else if (z.side === 'trasera') r = { x: ox + z.from * w, y: oy + l - dpx, width: (z.to - z.from) * w, height: dpx };
    else if (z.side === 'izquierda') r = { x: ox, y: oy + z.from * l, width: dpx, height: (z.to - z.from) * l };
    else if (z.side === 'derecha') r = { x: ox + w - dpx, y: oy + z.from * l, width: dpx, height: (z.to - z.from) * l };
    else r = { x: ox + 6, y: oy + z.from * l, width: w - 12, height: (z.to - z.from) * l };
    add('rect', { ...r, class: z.side === 'techo' ? 'zone roof' : 'zone' });
  }
  svg.addEventListener('click', (ev) => {
    const pt = svg.getBoundingClientRect();
    const sx = ((ev.clientX - pt.left) / pt.width) * (w + 60) - ox;
    const sy = ((ev.clientY - pt.top) / pt.height) * (l + 40) - oy;
    const dists: [DamageSide, number][] = [
      ['frontal', Math.abs(sy)],
      ['trasera', Math.abs(l - sy)],
      ['izquierda', Math.abs(sx)],
      ['derecha', Math.abs(w - sx)],
    ];
    dists.sort((a, b) => a[1] - b[1]);
    const side = dists[0][0];
    const c = side === 'frontal' || side === 'trasera' ? sx / w : sy / l;
    const span = side === 'frontal' || side === 'trasera' ? 0.4 : 0.25;
    const zone: DamageZone = {
      id: newId('d'),
      side,
      from: Math.max(0, Math.min(1 - span, c - span / 2)),
      to: Math.min(1, Math.max(span, c + span / 2)),
      depth: 0.25,
      hFrom: 0.1,
      hTo: 0.65,
      note: '',
    };
    change(() => e.damage.push(zone));
  });
  el.append(h('div', { class: 'damage-wrap' }, svg as unknown as HTMLElement, h('p', { class: 'muted' }, 'Haz clic junto a un lado de la silueta para marcar una zona dañada. Ajusta su tramo y profundidad abajo; la carrocería 3D se deforma al momento.')));

  e.damage.forEach((z, i) => {
    const sideSel = h('select', { onchange: (ev: Event) => change(() => (z.side = (ev.target as HTMLSelectElement).value as DamageSide)) });
    for (const [kk, lbl] of Object.entries(SIDE_LABEL)) sideSel.append(h('option', { value: kk, selected: kk === z.side }, lbl));
    const along = z.side === 'frontal' || z.side === 'trasera' ? ['izq.', 'der.'] : ['delante', 'detrás'];
    el.append(
      h(
        'div',
        { class: 'damage-zone' },
        h(
          'div',
          { class: 'row', style: 'align-items:center' },
          h('strong', { style: 'flex:1' }, `Zona ${i + 1}`),
          h('button', { class: 'icon-btn small danger', title: 'Quitar zona', html: ICON.trash, onclick: () => change(() => e.damage.splice(i, 1)) }),
        ),
        h('label', { class: 'field' }, h('span', {}, 'Lado'), sideSel),
        h(
          'div',
          { class: 'grid2' },
          numberField(`Desde (${along[0]})`, z.from * 100, (v) => change(() => (z.from = Math.max(0, Math.min(z.to - 0.02, v / 100)))), '%', 5, 0, 100),
          numberField(`Hasta (${along[1]})`, z.to * 100, (v) => change(() => (z.to = Math.min(1, Math.max(z.from + 0.02, v / 100)))), '%', 5, 0, 100),
          numberField('Profundidad', z.depth * 100, (v) => change(() => (z.depth = Math.max(0, v / 100))), 'cm', 1, 0, 200),
          numberField('Altura desde', z.hFrom * 100, (v) => change(() => (z.hFrom = Math.max(0, Math.min(z.hTo, v / 100)))), '%', 5, 0, 100),
          numberField('Altura hasta', z.hTo * 100, (v) => change(() => (z.hTo = Math.min(1, Math.max(z.hFrom, v / 100)))), '%', 5, 0, 100),
        ),
        h('input', { type: 'text', placeholder: 'Nota (p. ej. «paragolpes y aleta delantera izq. hundidos»)', value: z.note, onchange: (ev: Event) => change(() => (z.note = (ev.target as HTMLInputElement).value)) }),
      ),
    );
  });
  const lenAlong = e.damage.reduce((s, z) => s + (z.to - z.from) * (z.side === 'frontal' || z.side === 'trasera' ? sp.W : sp.L), 0);
  if (e.damage.length) el.append(h('p', { class: 'muted' }, `Longitud dañada total: ${fmt(lenAlong)} m. Profundidad máxima: ${fmt(Math.max(...e.damage.map((z) => z.depth)) * 100, 0)} cm.`));
}

// ---------------- Fotos ----------------

function renderPhotos(el: HTMLElement, ed: Editor, e: VehicleEntity) {
  el.append(h('div', { class: 'cat-title' }, `Fotos (${e.photos.length})`));
  const grid = h('div', { class: 'thumbs' });
  e.photos.forEach((id, i) => {
    const url = ed.store.assets.get(id);
    if (!url) return;
    grid.append(
      h(
        'div',
        { class: 'thumb' },
        h('img', { src: url, alt: `Foto ${i + 1} de ${e.label}`, onclick: () => lightbox(url, `${e.name} · foto ${i + 1}`) }),
        h('button', { class: 'icon-btn small danger', title: 'Quitar foto', html: ICON.trash, onclick: () => ed.store.edit(() => e.photos.splice(i, 1), { type: 'entity', id: e.id }) }),
      ),
    );
  });
  const file = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    style: 'display:none',
    onchange: async (ev: Event) => {
      const files = [...((ev.target as HTMLInputElement).files ?? [])];
      const ids: string[] = [];
      for (const f of files) {
        try {
          const { url } = await readImage(f, false);
          const id = newId('img');
          ed.store.assets.set(id, url);
          ids.push(id);
        } catch {
          toast(`No se pudo leer ${f.name}`, 'error');
        }
      }
      if (ids.length) ed.store.edit(() => e.photos.push(...ids), { type: 'entity', id: e.id });
    },
  });
  el.append(grid, file, h('button', { class: 'btn', onclick: () => file.click() }, 'Añadir fotos del vehículo…'));
}

function lightbox(url: string, title: string) {
  const close = () => ov.remove();
  const ov: HTMLDivElement = h('div', { class: 'help-overlay', onclick: close }, h('figure', { class: 'lightbox' }, h('img', { src: url, alt: title }), h('figcaption', {}, title)));
  document.body.append(ov);
}

// ---------------- Conducción simulada ----------------

const fmtT = (t: number) => (Math.abs(t) < 0.005 ? '0,00 s' : `${t < 0 ? '−' : '+'}${fmt(Math.abs(t), 2)} s`);
const ACTIONS: [DriverEvent['action'], string, string][] = [
  ['frenar', 'Frenar', '0–1 (1 = a fondo)'],
  ['girar', 'Girar volante', '° en ruedas (+ der., − izq.)'],
  ['recto', 'Volver a la ruta', ''],
  ['acelerar', 'Acelerar', '0–1'],
  ['soltar', 'Soltar pedales', ''],
];

function renderDrive(el: HTMLElement, ed: Editor, e: VehicleEntity) {
  const change = (fn: () => void) => ed.store.edit(fn, { type: 'entity', id: e.id });
  el.append(h('div', { class: 'cat-title' }, 'Conducción y simulación física'));
  const roads = ed.store.project.entities.filter((x): x is RoadEntity => x.kind === 'road');
  if (!e.drive) {
    el.append(
      h(
        'p',
        { class: 'muted' },
        'Vehículo parado: si otro lo golpea, la simulación lo desplaza. Para que circule, dale una ruta y una velocidad; su movimiento, el choque y la posición final los calcula la física.',
      ),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () =>
            change(() => {
              e.drive = {
                path: laneRoute(ed.world, roads, e.x, e.z, e.heading),
                speed: e.spec.tipo === 'peaton' ? 5 : 50,
                sync: false,
                abs: true,
                events: [],
                showFinal: false,
              };
            }),
        },
        'Darle movimiento',
      ),
    );
    return;
  }
  const d = e.drive;
  const sv = ed.world.sim?.vehicles.get(e.id);
  const off = ed.world.sim?.syncOffsets.get(e.id);
  el.append(
    h(
      'div',
      { class: 'grid2' },
      h(
        'label',
        { class: 'field' },
        h('span', {}, 'Velocidad inicial'),
        h('input', { type: 'number', step: 1, min: 0, value: d.speed, onchange: (ev: Event) => change(() => (d.speed = Math.max(0, Number((ev.target as HTMLInputElement).value)))) }),
        h('output', {}, 'km/h'),
      ),
    ),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: d.abs, onchange: (ev: Event) => change(() => (d.abs = (ev.target as HTMLInputElement).checked)) }),
      'Frenos con ABS (sin ABS, al frenar a fondo las ruedas se bloquean y dejan huella)',
    ),
    h(
      'label',
      { class: 'check' },
      h('input', { type: 'checkbox', checked: d.sync, onchange: (ev: Event) => change(() => (d.sync = (ev.target as HTMLInputElement).checked)) }),
      'Llegar al punto de colisión en t = 0',
    ),
  );
  const ip = ed.store.project.impact;
  el.append(
    h(
      'div',
      { class: 'row wrap' },
      h(
        'button',
        {
          class: 'btn small',
          onclick: () => {
            toast('Haz clic en la escena donde se produjo la colisión.');
            ed.pickOnce = (p) => {
              ed.store.edit(() => (ed.store.project.impact = { x: p.x, z: p.z }), { type: 'env' });
              toast('Punto de colisión fijado. Los vehículos sincronizados llegarán a él en t = 0.');
            };
          },
        },
        ip ? 'Mover punto de colisión…' : 'Fijar punto de colisión…',
      ),
      h('button', { class: 'btn small', onclick: () => change(() => (d.path = laneRoute(ed.world, roads, e.x, e.z, e.heading))) }, 'Ruta por el carril'),
      h('button', { class: 'btn small', onclick: () => change(() => d.path.reverse()) }, 'Invertir sentido'),
    ),
    h(
      'p',
      { class: 'muted' },
      d.sync && !ip
        ? 'Para sincronizar, fija el punto de colisión (en el croquis suele estar marcado con una X).'
        : `Ruta de ${d.path.length} puntos: arrástralos en la escena (los blancos insertan uno nuevo; Supr borra el seleccionado). ${off !== undefined ? `Sale ${Math.round(Math.max(0, -off))} m antes del inicio de la ruta dibujada.`.replace('Sale 0 m antes del inicio de la ruta dibujada.', '') : ''}`,
    ),
  );

  // Acciones del conductor
  el.append(h('div', { class: 'cat-title' }, 'Acciones del conductor'));
  const evs = [...d.events].sort((a, b) => a.t - b.t);
  if (!evs.length) el.append(h('p', { class: 'muted' }, 'Sin acciones: circula por su ruta manteniendo la velocidad. Añade frenadas, volantazos o aceleraciones en el instante en que ocurren.'));
  for (const ev of evs) {
    const sel = h('select', { onchange: (x: Event) => change(() => (ev.action = (x.target as HTMLSelectElement).value as DriverEvent['action'])) });
    for (const [k, l] of ACTIONS) sel.append(h('option', { value: k, selected: k === ev.action }, l));
    const hint = ACTIONS.find((a) => a[0] === ev.action)?.[2] ?? '';
    el.append(
      h(
        'div',
        { class: 'ev-row' },
        h('input', { type: 'number', step: 0.05, value: ev.t, title: 'Instante (s, 0 = impacto)', onchange: (x: Event) => change(() => (ev.t = Number((x.target as HTMLInputElement).value))) }),
        sel,
        hint
          ? h('input', { type: 'number', step: ev.action === 'girar' ? 1 : 0.1, value: ev.value, title: hint, onchange: (x: Event) => change(() => (ev.value = Number((x.target as HTMLInputElement).value))) })
          : h('span', {}),
        h('button', { class: 'icon-btn small danger', title: 'Quitar acción', html: ICON.trash, onclick: () => change(() => d.events.splice(d.events.indexOf(ev), 1)) }),
      ),
    );
  }
  el.append(
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn small', onclick: () => change(() => d.events.push({ id: newId('ev'), t: Math.round(ed.world.time * 100) / 100, action: 'frenar', value: 1 })) }, `+ Frenar en ${fmtT(ed.world.time)}`),
      h('button', { class: 'btn small', onclick: () => change(() => d.events.push({ id: newId('ev'), t: Math.round(ed.world.time * 100) / 100, action: 'girar', value: -8 })) }, `+ Volantazo en ${fmtT(ed.world.time)}`),
    ),
  );

  // Resultados de la simulación
  if (sv) {
    el.append(h('div', { class: 'cat-title' }, 'Resultados de la simulación'));
    const rows: [string, string][] = [];
    rows.push(['Velocidad inicial', `${Math.round(sv.frames[0].v * 3.6)} km/h`]);
    if (sv.impactSpeed !== null && sv.firstContact !== null) {
      rows.push(['Primer contacto', fmtT(sv.firstContact)]);
      rows.push(['Velocidad en el impacto', `${Math.round(sv.impactSpeed * 3.6)} km/h`]);
    } else rows.push(['Contacto', 'no choca con nada']);
    for (const c of ed.world.sim!.contacts.filter((c) => (c.a === e.id || c.b === e.id) && c.peakForce > 2000)) {
      const mine = c.a === e.id;
      const other = mine ? c.bName : ed.store.get(c.a)?.name ?? c.a;
      rows.push([`Choque con ${other}`, `Δv ${Math.round((mine ? c.dvA : c.dvB) * 3.6)} km/h · aplastamiento ${fmt((mine ? c.crushA : c.crushB) * 100, 0)} cm · ${fmt(c.peakForce / 1000, 0)} kN`]);
    }
    const last = sv.frames[sv.frames.length - 1];
    rows.push(['Reposo', sv.restTime !== null ? `${fmtT(sv.restTime)} · (${fmt(last.x, 1)}, ${fmt(last.z, 1)}) rumbo ${Math.round(last.h)}°` : `sigue moviéndose a ${Math.round(last.v * 3.6)} km/h al final`]);
    el.append(h('div', { class: 'results-table' }, ...rows.map(([k, v]) => h('div', {}, h('span', {}, k), h('strong', {}, v)))));
    // comparación con la posición final observada
    el.append(
      h(
        'label',
        { class: 'check' },
        h('input', { type: 'checkbox', checked: !!d.showFinal, onchange: (x: Event) => change(() => (d.showFinal = (x.target as HTMLInputElement).checked)) }),
        'Comparar con la posición final observada (croquis)',
      ),
    );
    if (d.showFinal) {
      const dist = Math.hypot(last.x - e.x, last.z - e.z);
      const dh = Math.abs(((last.h - e.heading + 540) % 360) - 180);
      el.append(
        h('p', { class: dist < 1 && dh < 10 ? 'ok' : 'warn' }, `El reposo simulado queda a ${fmt(dist, 1)} m y ${Math.round(dh)}° de la posición final observada.`),
        h('p', { class: 'muted' }, 'La posición observada es el contorno discontinuo: muévelo o gíralo con el gizmo (G/R) hasta donde quedó el vehículo según el croquis y ajusta velocidades y acciones hasta que coincidan.'),
        h(
          'button',
          {
            class: 'btn small',
            onclick: () =>
              change(() => {
                e.x = last.x;
                e.z = last.z;
                e.heading = last.h;
              }),
          },
          'Copiar el reposo simulado como posición observada',
        ),
      );
    }
  }
  el.append(h('button', { class: 'btn', onclick: () => change(() => delete e.drive) }, 'Quitar movimiento (dejar parado)'));
}
