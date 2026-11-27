import type { Editor } from '../editor';
import { demoProject } from '../model/demo';
import { geoAt } from '../io/dem';
import { ROAD_KINDS, TEMPLATES, templateProject, type RoadKind, type TemplateId } from '../model/templates';
import { loadRealRelief } from '../tools/elevationPanel';
import { addOverlay, loadOrtho, readImage } from '../tools/overlayTool';
import { clear, h, toast } from './dom';

const I = (d: string) => `<svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CARD_ICONS = {
  tpl: I('<path d="M17 4L9 44M31 4l8 40M24 8v6M24 20v8M24 34v6"/>'),
  air: I('<rect x="5" y="9" width="38" height="30" rx="3"/><path d="M5 31l11-10 9 8 6-5 12 10"/><circle cx="33" cy="18" r="3"/>'),
  photo: I('<path d="M6 15h8l3-4h14l3 4h8v24H6z"/><circle cx="24" cy="26" r="7"/>'),
  sketch: I('<path d="M8 40l6-2 22-22-4-4-22 22z"/><path d="M28 12l4 4"/><path d="M8 8c6 0 6 6 12 6s6-6 12-6"/>'),
  geo: I('<path d="M24 44s14-12.5 14-24a14 14 0 0 0-28 0c0 11.5 14 24 14 24z"/><circle cx="24" cy="20" r="5"/>'),
  demo: I('<path d="M6 30l8-8 6 6 8-10 14 14"/><rect x="4" y="6" width="40" height="34" rx="3"/>'),
};

interface Opts {
  /** Primera vez que se abre la aplicación (detrás está el ejemplo). */
  first?: boolean;
  openFile?: () => void;
}

/**
 * «¿Cómo quieres empezar?»: plantillas de carretera, captura aérea con calibración de escala,
 * fotos del lugar, croquis a mano, lugar real (IGN) o el ejemplo.
 */
export function openStartWizard(ed: Editor, opts: Opts = {}) {
  const ov: HTMLDivElement = h('div', { class: 'help-overlay start-overlay' });
  const card = h('div', { class: 'help-card start-card' });
  ov.append(card);
  document.body.append(ov);
  const close = () => {
    ov.remove();
    window.removeEventListener('paste', onPaste, true);
  };
  let caseName = '';
  let tpl: TemplateId = 'recta';
  let kind: RoadKind = 'convencional';
  let pasteTarget: ((b: Blob) => void) | null = null;
  const onPaste = (e: ClipboardEvent) => {
    if (!pasteTarget) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const f = item?.getAsFile();
    if (f) {
      e.preventDefault();
      e.stopPropagation();
      pasteTarget(f);
    }
  };
  window.addEventListener('paste', onPaste, true);

  const nameField = () =>
    h(
      'label',
      { class: 'field wide start-name' },
      h('span', {}, 'Nombre del caso'),
      h('input', { type: 'text', placeholder: 'p. ej. Colisión frontal en la CV-123, km 12', value: caseName, oninput: (e: Event) => (caseName = (e.target as HTMLInputElement).value) }),
    );

  /** Crea el escenario, cierra y encuadra. */
  const start = (tplId: TemplateId, then?: () => void | Promise<void>) => {
    const p = templateProject(tplId, kind, caseName.trim() || 'Escenario sin título');
    ed.store.load(p, new Map());
    ed.player?.setTime(ed.player.range().start);
    close();
    ed.setTool('select');
    setTimeout(async () => {
      ed.frameAll();
      await then?.();
    }, 250);
  };

  const back = () => h('button', { class: 'btn small start-back', onclick: () => home() }, '← Volver');

  const tplPicker = () => {
    const grid = h('div', { class: 'tpl-grid' });
    const draw = () => {
      clear(grid);
      for (const t of TEMPLATES)
        grid.append(
          h(
            'button',
            { class: 'tpl' + (t.id === tpl ? ' on' : ''), onclick: () => ((tpl = t.id), draw()) },
            h('span', { class: 'tpl-svg', html: `<svg viewBox="0 0 60 60" stroke="currentColor" stroke-linecap="round">${t.svg}</svg>` }),
            h('strong', {}, t.label),
            h('small', {}, t.desc),
          ),
        );
    };
    draw();
    const sel = h('select', { onchange: (e: Event) => (kind = (e.target as HTMLSelectElement).value as RoadKind) });
    for (const k of ROAD_KINDS) sel.append(h('option', { value: k.id, selected: k.id === kind }, k.label));
    return h('div', {}, grid, h('label', { class: 'field wide' }, h('span', {}, 'Tipo de vía'), sel));
  };

  /** Zona para soltar, elegir o pegar una imagen. */
  const dropZone = (label: string, onFile: (f: Blob, name: string) => void, multiple = false) => {
    const input = h('input', {
      type: 'file',
      accept: 'image/*',
      multiple,
      style: 'display:none',
      onchange: (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) onFile(f, f.name.replace(/\.[^.]+$/, ''));
      },
    });
    const z: HTMLDivElement = h(
      'div',
      {
        class: 'drop-zone',
        tabindex: 0,
        onclick: () => input.click(),
        ondragover: (e: Event) => (e.preventDefault(), z.classList.add('over')),
        ondragleave: () => z.classList.remove('over'),
        ondrop: (e: Event) => {
          e.preventDefault();
          z.classList.remove('over');
          const f = (e as DragEvent).dataTransfer?.files?.[0];
          if (f && f.type.startsWith('image/')) onFile(f, f.name.replace(/\.[^.]+$/, ''));
        },
      },
      input,
      h('div', { class: 'dz-icon', html: CARD_ICONS.air }),
      h('strong', {}, label),
      h('span', { class: 'muted' }, 'Arrastra la imagen aquí, haz clic para elegirla o pégala con Ctrl+V'),
    );
    pasteTarget = (b) => onFile(b, 'Imagen pegada');
    return z;
  };

  const views: Record<string, () => void> = {
    tpl: () => {
      clear(card);
      card.append(back(), h('h2', {}, 'Empezar con una carretera tipo'), h('p', { class: 'muted' }, 'Elige el trazado más parecido al lugar: después puedes mover sus puntos, cambiar la sección, añadir carriles, aceras, muros o árboles.'), nameField(), tplPicker(), h('div', { class: 'row end' }, h('button', { class: 'btn primary big', onclick: () => start(tpl, () => toast('Escenario creado. Siguiente paso: añade los vehículos (botón «2 Vehículos» arriba).', 'info', 6000)) }, 'Crear escenario')));
    },
    air: () => aerial(false),
    sketch: () => aerial(true),
    photo: () => {
      clear(card);
      let photo: { b: Blob; name: string } | null = null;
      const status = h('p', { class: 'muted' }, '');
      const go = h('button', { class: 'btn primary big', disabled: true, onclick: () => start(tpl, async () => {
            if (photo) await ed.preparePhoto?.(photo.b, photo.name);
          }) }, 'Crear y colocar la foto');
      card.append(
        back(),
        h('h2', {}, 'A partir de fotos del lugar'),
        h('p', { class: 'muted' }, 'Fotos a pie de calle, de tu móvil o capturas de Street View. Primero elige el trazado parecido; después harás clic donde se tomó la foto y la girarás hasta que encaje con la escena: así podrás calcar la carretera, los bordes y los objetos sobre ella.'),
        nameField(),
        tplPicker(),
        dropZone('Foto o captura de Street View', (b, name) => {
          photo = { b, name };
          status.textContent = `Foto lista: ${name}`;
          go.disabled = false;
        }),
        status,
        h('div', { class: 'row end' }, go),
      );
    },
    geo: () => {
      clear(card);
      let lat = 40.4168;
      let lon = -3.7038;
      let size = 300;
      let relief = true;
      let ortho = true;
      const msg = h('p', { class: 'muted' }, '');
      const coords = h('input', {
        type: 'text',
        placeholder: 'Coordenadas (de Google Maps: clic derecho → copiar), p. ej. 39.4699, -0.3763',
        onchange: (e: Event) => {
          const m = (e.target as HTMLInputElement).value.match(/(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/);
          if (m) {
            lat = Number(m[1].replace(',', '.'));
            lon = Number(m[2].replace(',', '.'));
            msg.textContent = `Centro: ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          }
        },
      });
      const addr = h('input', { type: 'text', placeholder: 'o busca una dirección: calle, municipio…' });
      const search = async () => {
        const q = addr.value.trim();
        if (!q) return;
        msg.textContent = 'Buscando…';
        try {
          const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=es&q=${encodeURIComponent(q)}`);
          const j = (await r.json()) as { lat: string; lon: string; display_name: string }[];
          if (!j.length) throw new Error('No se ha encontrado esa dirección.');
          lat = Number(j[0].lat);
          lon = Number(j[0].lon);
          coords.value = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
          msg.textContent = j[0].display_name;
        } catch (err) {
          msg.textContent = `No se pudo buscar (${(err as Error).message}). Pega las coordenadas copiadas de Google Maps.`;
        }
      };
      const sizeSel = h('select', { onchange: (e: Event) => (size = Number((e.target as HTMLSelectElement).value)) });
      for (const v of [150, 300, 500]) sizeSel.append(h('option', { value: v, selected: v === size }, `${v} m de lado`));
      const go = h(
        'button',
        {
          class: 'btn primary big',
          onclick: async () => {
            go.disabled = true;
            const p = templateProject('vacio', kind, caseName.trim() || `Escenario en ${lat.toFixed(4)}, ${lon.toFixed(4)}`);
            p.geo = geoAt(lat, lon);
            ed.store.load(p, new Map());
            msg.textContent = 'Descargando del IGN… (puede tardar unos segundos)';
            const errors: string[] = [];
            if (relief)
              try {
                await loadRealRelief(ed, lat, lon);
              } catch (err) {
                errors.push(`relieve: ${(err as Error).message}`);
              }
            if (ortho)
              try {
                await loadOrtho(ed, lat, lon, size);
              } catch (err) {
                errors.push(`ortofoto: ${(err as Error).message}`);
              }
            close();
            ed.setTool('select');
            setTimeout(() => ed.frameAll(), 300);
            if (errors.length) toast(`Escenario creado, pero no se pudo descargar ${errors.join(' · ')}. Puedes cargar una captura como calco.`, 'error', 10000);
            else toast('Lugar cargado a escala real. Dibuja la carretera sobre la ortofoto con la herramienta Carretera (C).', 'info', 7000);
          },
        },
        'Cargar el lugar',
      );
      card.append(
        back(),
        h('h2', {}, 'Un lugar real (España)'),
        h('p', { class: 'muted' }, 'Descarga la ortofoto aérea del PNOA y el relieve real del IGN, georreferenciados y a escala. Luego calcas la carretera encima.'),
        nameField(),
        h('label', { class: 'field wide' }, coords),
        h('div', { class: 'row' }, addr, h('button', { class: 'btn', onclick: search }, 'Buscar')),
        msg,
        h('div', { class: 'row wrap' }, h('label', { class: 'field' }, h('span', {}, 'Zona'), sizeSel), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: ortho, onchange: (e: Event) => (ortho = (e.target as HTMLInputElement).checked) }), 'Ortofoto'), h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: relief, onchange: (e: Event) => (relief = (e.target as HTMLInputElement).checked) }), 'Relieve real')),
        h('div', { class: 'row end' }, go),
      );
    },
  };

  /** Captura aérea (o croquis) como calco con calibración de escala. */
  const aerial = (sketch: boolean) => {
    clear(card);
    let width = sketch ? 60 : 150;
    const wIn = h('input', { type: 'number', min: 10, max: 2000, step: 10, value: width, onchange: (e: Event) => (width = Number((e.target as HTMLInputElement).value) || width) });
    card.append(
      back(),
      h('h2', {}, sketch ? 'A partir del croquis dibujado a mano' : 'A partir de una captura aérea'),
      h(
        'p',
        { class: 'muted' },
        sketch
          ? 'Foto o escaneo del croquis. El papel blanco se vuelve transparente para calcar encima. Después marcarás dos puntos de una medida conocida (por ejemplo, el ancho de la calzada) para ponerlo a escala.'
          : 'Captura de Google Maps (vista satélite), de un visor de ortofotos o de un plano. Después marcarás dos puntos de una distancia conocida (por ejemplo, los extremos de la barra de escala de Google Maps) y quedará a escala real.',
      ),
      nameField(),
      h('label', { class: 'field' }, h('span', {}, 'Ancho aproximado de la imagen'), wIn, h('output', {}, 'm')),
      dropZone(sketch ? 'Croquis (foto o escaneo)' : 'Captura de Google Maps u ortofoto', async (b, name) => {
        try {
          const { url, aspect } = await readImage(b, sketch);
          start('vacio', () => {
            const o = addOverlay(ed, url, aspect, sketch ? `Croquis: ${name}` : `Captura: ${name}`, width, 0, 0);
            if (sketch) ed.store.edit(() => (o.onRoads = true), { type: 'entity', id: o.id });
            ed.frameAll();
            setTimeout(() => {
              ed.calibrateOverlay?.(o.id);
              toast('Pon la imagen a escala: haz clic en dos puntos de una distancia conocida y escribe cuánto mide.', 'info', 9000);
            }, 400);
          });
        } catch (err) {
          toast((err as Error).message, 'error');
        }
      }),
    );
  };

  const home = () => {
    pasteTarget = null;
    clear(card);
    const c = (key: keyof typeof CARD_ICONS, title: string, text: string, fn: () => void, cls = '') => h('button', { class: 'start-opt ' + cls, onclick: fn }, h('span', { class: 'so-icon', html: CARD_ICONS[key] }), h('strong', {}, title), h('span', {}, text));
    card.append(
      h('div', { class: 'start-head' }, h('h2', {}, opts.first ? 'Bienvenido a Catacrash' : 'Nuevo escenario'), h('p', { class: 'muted' }, '¿Cómo quieres empezar? Todo se puede cambiar después.')),
      h(
        'div',
        { class: 'start-grid' },
        c('tpl', 'Carretera tipo', 'Recta, curva, cruce en T o en X, glorieta… lista en un clic.', views.tpl, 'primary'),
        c('air', 'Captura aérea', 'Google Maps (satélite), ortofoto o plano. Se calca y se pone a escala.', views.air),
        c('photo', 'Fotos del lugar', 'Fotos a pie de calle o capturas de Street View, encajadas en 3D.', views.photo),
        c('sketch', 'Croquis a mano', 'El dibujo del atestado como plantilla transparente.', views.sketch),
        c('geo', 'Lugar real (España)', 'Coordenadas o dirección: ortofoto y relieve del IGN.', views.geo),
        c('demo', opts.first ? 'Ver el ejemplo' : 'Abrir el ejemplo', 'Una colisión frontal en curva ya reconstruida, para explorar.', () => {
          if (!opts.first) {
            const d = demoProject();
            ed.store.load(d.project, d.assets);
          }
          close();
          setTimeout(() => ed.frameAll(), 250);
        }),
      ),
      h(
        'div',
        { class: 'start-foot' },
        opts.openFile ? h('button', { class: 'btn', onclick: () => (close(), opts.openFile!()) }, 'Abrir un escenario guardado…') : null,
        h('span', { class: 'muted' }, 'Consejo: en cualquier momento puedes pegar (Ctrl+V) una captura o una foto y la app te preguntará qué es.'),
        h('button', { class: 'btn', onclick: close }, opts.first ? 'Seguir con el ejemplo' : 'Cancelar'),
      ),
    );
  };
  home();
}

/**
 * Pegar una imagen en cualquier momento (Ctrl+V): la app pregunta qué es y la coloca como calco
 * (captura aérea o croquis, con calibración de escala) o como foto de referencia.
 */
export function installPasteImage(ed: Editor) {
  window.addEventListener('paste', (e) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (document.querySelector('.start-overlay')) return;
    const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
    const blob = item?.getAsFile();
    if (!blob) return;
    e.preventDefault();
    const ov: HTMLDivElement = h('div', { class: 'help-overlay', onclick: (ev: Event) => ev.target === ov && ov.remove() });
    const asOverlay = async (sketch: boolean) => {
      ov.remove();
      const { url, aspect } = await readImage(blob, sketch);
      const t0 = ed.vp.controls.target;
      const o = addOverlay(ed, url, aspect, sketch ? 'Croquis pegado' : 'Captura pegada', sketch ? 60 : 150, t0.x, t0.z);
      ed.calibrateOverlay?.(o.id);
      toast('Pon la imagen a escala: clic en dos puntos de una distancia conocida y escribe cuánto mide.', 'info', 8000);
    };
    ov.append(
      h(
        'div',
        { class: 'help-card', style: 'width:min(560px,92vw)' },
        h('h2', {}, '¿Qué es esta imagen?'),
        h('div', { class: 'paste-preview' }, h('img', { src: URL.createObjectURL(blob), alt: 'Imagen pegada' })),
        h(
          'div',
          { class: 'start-grid three' },
          h('button', { class: 'start-opt', onclick: () => asOverlay(false) }, h('span', { class: 'so-icon', html: CARD_ICONS.air }), h('strong', {}, 'Vista aérea'), h('span', {}, 'Captura de mapa u ortofoto → calco en el suelo')),
          h('button', { class: 'start-opt', onclick: () => asOverlay(true) }, h('span', { class: 'so-icon', html: CARD_ICONS.sketch }), h('strong', {}, 'Croquis'), h('span', {}, 'Dibujo en papel → calco transparente')),
          h('button', { class: 'start-opt', onclick: () => (ov.remove(), ed.preparePhoto?.(blob, 'Foto pegada')) }, h('span', { class: 'so-icon', html: CARD_ICONS.photo }), h('strong', {}, 'Foto del lugar'), h('span', {}, 'A pie de calle o Street View → foto de referencia')),
        ),
        h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => ov.remove() }, 'Cancelar')),
      ),
    );
    document.body.append(ov);
  });
}
