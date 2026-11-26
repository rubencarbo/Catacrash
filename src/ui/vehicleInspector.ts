import type { Editor } from '../editor';
import { newId } from '../model/store';
import type { DamageSide, DamageZone, SpecKey, VehicleEntity, VehicleType } from '../model/types';
import { readImage } from '../tools/overlayTool';
import { specTitle } from '../tools/vehicleTool';
import { saveToLibrary } from '../vehicles/catalog';
import { respec, TYPICAL } from '../vehicles/spec';
import { fmt, h, toast } from './dom';
import { motionWarnings } from '../anim/motion';
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

  renderMotion(el, ed, e);
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

// ---------------- Trayectoria ----------------

const fmtT = (t: number) => `${t < 0 ? '−' : t > 0 ? '+' : ''}${fmt(Math.abs(t), 2)} s`;

function renderMotion(el: HTMLElement, ed: Editor, e: VehicleEntity) {
  const change = (fn: () => void) => {
    ed.store.edit(fn, { type: 'entity', id: e.id });
    ed.world.invalidateMotion(e.id);
  };
  el.append(h('div', { class: 'cat-title' }, 'Trayectoria y velocidades'));
  const keys = e.motion ?? [];
  if (!keys.length) {
    el.append(
      h(
        'p',
        { class: 'muted' },
        'Vehículo estático. Para animarlo crea su trayectoria: se guarda su posición actual en el instante marcado en la línea de tiempo. Después mueve el tiempo y arrastra el vehículo; cada movimiento crea o actualiza una posición clave.',
      ),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () =>
            change(() => {
              e.motion = [{ id: newId('k'), t: Math.round(ed.world.time * 100) / 100, x: e.x, z: e.z, heading: e.heading, speed: null, marks: false }];
            }),
        },
        'Animar este vehículo',
      ),
    );
    return;
  }
  const m = ed.world.motionOf(e);
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const sel = ed.store.selection?.id === e.id ? ed.store.selection.point : undefined;
  const table = h('div', { class: 'keys-table' });
  table.append(h('div', { class: 'kh' }, h('span', {}, 'Tiempo'), h('span', {}, 'Velocidad'), h('span', {}, 'Rumbo'), h('span', { title: 'Deja huella de neumáticos hasta la siguiente clave' }, 'Huella'), h('span', {})));
  sorted.forEach((k, i) => {
    const idx = keys.indexOf(k);
    const ks = m?.keySpeeds[i];
    const kmh = ks ? Math.round(ks.v * 3.6) : 0;
    table.append(
      h(
        'div',
        { class: 'kr' + (idx === sel ? ' sel' : '') },
        h('input', {
          type: 'number',
          step: 0.05,
          value: k.t,
          title: 'Tiempo de esta posición (s, 0 = impacto)',
          onchange: (ev: Event) => change(() => (k.t = Number((ev.target as HTMLInputElement).value))),
          onfocus: () => {
            ed.player?.pause();
            ed.player?.setTime(k.t);
          },
        }),
        h('input', {
          type: 'number',
          step: 1,
          min: 0,
          value: k.speed ?? '',
          placeholder: String(kmh),
          class: k.speed === null ? 'derived' : '',
          title: k.speed === null ? `Deducida: ${kmh} km/h. Escribe un valor para fijarla.` : 'Velocidad fijada (km/h). Bórrala para que se deduzca.',
          onchange: (ev: Event) => {
            const v = (ev.target as HTMLInputElement).value;
            change(() => (k.speed = v === '' ? null : Math.max(0, Number(v))));
          },
        }),
        k.t === 0 && i < sorted.length - 1
          ? h('input', {
              type: 'number',
              step: 1,
              min: 0,
              value: k.speedOut ?? '',
              placeholder: 'salida',
              class: 'speed-out',
              title: 'Velocidad justo después del impacto (km/h). El salto de velocidad del choque no cuenta como frenada.',
              onchange: (ev: Event) => {
                const v = (ev.target as HTMLInputElement).value;
                change(() => (k.speedOut = v === '' ? null : Math.max(0, Number(v))));
              },
            })
          : null,
        h('input', {
          type: 'number',
          step: 1,
          value: k.heading === null ? '' : Math.round(k.heading),
          placeholder: 'auto',
          title: 'Rumbo fijado (°). Vacío = sigue la trayectoria. Úsalo para trompos o derrapes.',
          onchange: (ev: Event) => {
            const v = (ev.target as HTMLInputElement).value;
            change(() => (k.heading = v === '' ? null : ((Number(v) % 360) + 360) % 360));
          },
        }),
        i < sorted.length - 1
          ? h('input', { type: 'checkbox', checked: k.marks, title: 'Huella de frenada/derrape en este tramo', onchange: (ev: Event) => change(() => (k.marks = (ev.target as HTMLInputElement).checked)) })
          : h('span', {}),
        h('button', { class: 'icon-btn small danger', title: 'Quitar esta posición', html: ICON.trash, onclick: () => change(() => keys.splice(idx, 1)) }),
      ),
    );
  });
  el.append(
    table,
    h(
      'div',
      { class: 'row wrap' },
      h(
        'button',
        {
          class: 'btn',
          onclick: () => {
            const p = ed.world.vehiclePose(e);
            const t = Math.round(ed.world.time * 100) / 100;
            if (keys.some((k) => Math.abs(k.t - t) < 0.03)) return toast(`Ya hay una posición en ${fmtT(t)}. Mueve el tiempo o arrastra el vehículo.`);
            change(() => keys.push({ id: newId('k'), t, x: p.x, z: p.z, heading: null, speed: null, marks: false }));
          },
        },
        `Añadir posición en ${fmtT(ed.world.time)}`,
      ),
      h('button', { class: 'btn', onclick: () => change(() => (e.motion = [])) }, 'Quitar trayectoria'),
    ),
  );
  if (m && m.segments.length) {
    const mu = ed.store.project.env.wet ? 0.5 : 0.8;
    const at0 = m.pose(-0.001);
    const k0 = m.keys.findIndex((k) => k.t === 0);
    const out0 = k0 >= 0 ? m.keySpeeds[k0].vOut : null;
    const v0 = m.keySpeeds[0].v;
    const info: string[] = [];
    info.push(`Velocidad en el impacto: ${Math.round(at0.speed * 3.6)} km/h${out0 !== null && Math.abs(out0 - at0.speed) > 0.3 ? `; tras el impacto ${Math.round(out0 * 3.6)} km/h (Δv ≈ ${Math.round(Math.abs(at0.speed - out0) * 3.6)} km/h)` : ''}.`);
    info.push(`Velocidad inicial: ${Math.round(v0 * 3.6)} km/h; con firme ${ed.store.project.env.wet ? 'mojado' : 'seco'} (μ ≈ ${String(mu).replace('.', ',')}) necesitaría ${fmt((v0 * v0) / (2 * mu * 9.81), 1)} m para detenerse frenando a fondo.`);
    const total = m.segments.reduce((s, g) => s + g.length, 0);
    info.push(`Recorrido total: ${fmt(total, 1)} m en ${fmt(m.segments[m.segments.length - 1].t1 - m.segments[0].t0, 2)} s.`);
    el.append(h('div', { class: 'motion-info' }, ...info.map((t) => h('p', {}, t))));
    for (const w of motionWarnings(m, ed.store.project.env.wet)) el.append(h('p', { class: 'warn' }, `⚠ ${w}`));
  }
  el.append(
    h(
      'p',
      { class: 'muted' },
      'Las velocidades en gris se deducen de tiempos y distancias; escribe un valor para fijarlas. Para modificar una posición, mueve el tiempo hasta ella y arrastra el vehículo, o arrastra su punto naranja sobre la trayectoria.',
    ),
  );
}
