import './style.css';
import * as THREE from 'three';
import { Editor, type Tool } from './editor';
import { download, deserialize, pickFile, serialize } from './io/file';
import { sceneToUtm } from './io/geo';
import { demoProject } from './model/demo';
import { isStaleDemo, migrateProject } from './model/migrate';
import { idbGet, Store } from './model/store';
import type { Project } from './model/types';
import { Viewport } from './scene/viewport';
import { World } from './scene/world';
import { drawTool, measureTool, selectTool } from './tools/basic';
import { overlayTool } from './tools/overlayTool';
import { placeTool } from './tools/place';
import { vehicleTool } from './tools/vehicleTool';
import { photoTool } from './tools/photoTool';
import { roundaboutTool } from './tools/roundaboutTool';
import { sculptTool } from './tools/sculpt';
import { clear, fmt, h, toast } from './ui/dom';
import { ICON } from './ui/icons';
import { Inspector } from './ui/inspector';
import { Outliner } from './ui/outliner';
import { Player } from './anim/player';
import { TimelineBar } from './ui/timeline';
import { openReport } from './ui/reportDialog';
import { openFitDialog } from './ui/fitDialog';
import { buildNavWidget } from './ui/navWidget';
import { buildQuickBar } from './ui/quickBar';
import { installPasteImage, openStartWizard } from './ui/startWizard';
import { buildSteps } from './ui/steps';
import { simulate as __sim } from './physics/sim';
import { analyze as __an } from './analysis/analyze';
import { candidateParams as __cp, evaluate as __ev, fit as __fit } from './physics/fit';

async function boot() {
  const saved = await idbGet<{ project: Project; assets: Record<string, string> }>('project');
  const demo = demoProject();
  // Una copia guardada del ejemplo antiguo (animación por claves) se sustituye por el ejemplo actual;
  // cualquier otro proyecto guardado se pone al día.
  let usable = !!saved?.project?.terrain?.base;
  let notice = '';
  if (usable && isStaleDemo(saved!.project)) {
    usable = false;
    notice = 'El escenario de ejemplo se ha actualizado a la nueva versión con simulación física.';
  } else if (usable) {
    const n = migrateProject(saved!.project);
    if (n) notice = `${n} vehículo(s) con trayectoria antigua convertidos a conducción simulada: revisa su velocidad y acciones.`;
  }
  const store = new Store(usable ? saved!.project : demo.project);
  store.assets = usable ? new Map(Object.entries(saved!.assets ?? {})) : demo.assets;

  const vpEl = document.getElementById('viewport')!;
  const vp = new Viewport(vpEl);
  const world = new World(store, vp);
  const ed = new Editor(store, vp, world);

  ed.register(selectTool(ed));
  ed.register(drawTool(ed, 'road'));
  ed.register(roundaboutTool(ed));
  ed.register(drawTool(ed, 'area'));
  ed.register(drawTool(ed, 'river'));
  ed.register(drawTool(ed, 'linear'));
  ed.register(vehicleTool(ed));
  ed.register(placeTool(ed));
  ed.register(sculptTool(ed));
  ed.register(overlayTool(ed));
  ed.register(photoTool(ed));
  ed.register(measureTool(ed));

  const player = new Player(store, world, vp);
  ed.player = player;
  // tras recolocar un vehículo después del choque, buscar las velocidades que lo reproducen
  ed.onNeedsFit = (id) => openFitDialog(ed, id, { autoRun: true });
  new TimelineBar(vpEl, ed, player);
  world.onRebuilt = (() => {
    const prev = world.onRebuilt;
    return () => {
      world.setTime(player.time);
      prev?.();
    };
  })();
  new Outliner(document.getElementById('outliner')!, ed);
  new Inspector(document.getElementById('inspector')!, ed);

  buildToolbar(ed);
  buildToolPanel(ed);
  buildTopbar(ed, store, world);
  buildStatus(ed, store);
  buildNavWidget(ed, vpEl);
  buildQuickBar(ed, vpEl);
  buildSteps(ed, vpEl, () => openFileWith(store));
  vp.groundHeight = (x, z) => world.surfaceHeight(x, z);

  installPasteImage(ed);
  document.getElementById('loading')?.remove();
  // primera visita: elegir cómo empezar (detrás queda el ejemplo)
  let seen = false;
  try {
    seen = localStorage.getItem('catacrash.inicio') === '1';
    localStorage.setItem('catacrash.inicio', '1');
  } catch {
    /* sin almacenamiento */
  }
  if (!seen) setTimeout(() => openStartWizard(ed, { first: true, exampleLoaded: !usable, openFile: () => openFileWith(store) }), 400);
  if (notice) setTimeout(() => toast(notice), 600);
  (window as unknown as { catacrash: unknown }).catacrash = { store, vp, world, ed, THREE, player, simulate: __sim, fitTools: { evaluate: __ev, candidateParams: __cp, fit: __fit }, analyze: __an };
}

function buildToolbar(ed: Editor) {
  const bar = document.getElementById('toolbar')!;
  const render = () => {
    clear(bar);
    for (const t of ed.tools.values()) {
      bar.append(
        h('button', {
          class: 'icon-btn' + (t === ed.tool ? ' active' : ''),
          title: `${t.label} (${t.key.toUpperCase()})`,
          'aria-label': t.label,
          html: t.icon,
          onclick: () => ed.setTool(t.id),
        }),
      );
    }
  };
  ed.onToolChange(render);
  render();
}

function buildToolPanel(ed: Editor) {
  const el = document.getElementById('tool-panel')!;
  const render = (t: Tool = ed.tool) => {
    clear(el);
    el.append(h('div', { class: 'tool-title' }, t.label));
    if (t.options) t.options(el);
    else if (t.id === 'select') {
      el.append(
        h('p', { class: 'muted' }, 'Haz clic sobre cualquier elemento para editarlo. Arrastra un vehículo u objeto para moverlo y su flecha naranja para girarlo. Los trazados muestran sus puntos de control: arrástralos sobre el terreno.'),
        h('div', { class: 'cat-title' }, 'Cámara'),
        shortcuts(
          ed.vp.mouseStyle === 'mapa'
            ? [
                ['Arrastrar (izq.)', 'Desplazar el mapa'],
                ['Arrastrar (der.)', 'Girar e inclinar'],
                ['Rueda', 'Acercar hacia el cursor'],
                ['Doble clic', 'Ir a ese punto'],
                ['Flechas · Q/E', 'Desplazar · girar'],
                ['P', 'Planta ↔ 3D'],
              ]
            : [
                ['Arrastrar (izq.)', 'Girar e inclinar'],
                ['Arrastrar (central)', 'Desplazar la escena'],
                ['Rueda', 'Acercar hacia el cursor'],
                ['Doble clic', 'Ir a ese punto'],
                ['Flechas · Q/E', 'Desplazar · girar'],
                ['P', 'Planta ↔ 3D'],
              ],
        ),
        h('div', { class: 'cat-title' }, 'Edición'),
        shortcuts([
          ['Arrastrar objeto', 'Moverlo (en el instante actual)'],
          ['Flecha naranja', 'Girarlo (Mayús: 15°)'],
          ['F', 'Encuadrar selección'],
          ['Ctrl+D', 'Duplicar'],
          ['Supr', 'Borrar (o el punto seleccionado)'],
          ['Ctrl+Z / Ctrl+Y', 'Deshacer / rehacer'],
        ]),
      );
    }
  };
  ed.refreshOptions = () => render();
  ed.onToolChange((t) => render(t));
  ed.store.onSelect(() => {
    if (ed.tool.id === 'overlay') render();
  });
  render();
}

function shortcuts(rows: [string, string][]) {
  const t = h('table', { class: 'keys' });
  for (const [k, v] of rows) t.append(h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', { class: 'muted' }, v)));
  return t;
}

/** Abre un escenario guardado (.json). */
async function openFileWith(store: Store) {
  const f = await pickFile('.json,application/json');
  if (!f) return;
  try {
    const { project, assets } = deserialize(await f.text());
    const n = migrateProject(project);
    store.load(project, assets);
    if (n) toast(`${n} vehículo(s) con trayectoria antigua convertidos a conducción simulada.`);
    toast(`Abierto: ${project.name}`);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

function buildTopbar(ed: Editor, store: Store, world: World) {
  const openFile = () => openFileWith(store);
  const bar = document.getElementById('topbar')!;
  const env = store.project.env;
  const name = h('input', {
    class: 'proj-name',
    value: store.project.name,
    title: 'Nombre del escenario',
    onchange: (e: Event) => store.edit(() => (store.project.name = (e.target as HTMLInputElement).value), { type: 'env' }),
  });
  const undo = h('button', { class: 'icon-btn', title: 'Deshacer (Ctrl+Z)', html: ICON.undo, onclick: () => store.undo() });
  const redo = h('button', { class: 'icon-btn', title: 'Rehacer (Ctrl+Y)', html: ICON.redo, onclick: () => store.redo() });
  const hourOut = h('output', {});
  const hour = h('input', {
    type: 'range',
    min: 0,
    max: 24,
    step: 0.25,
    title: 'Hora del día',
    oninput: (e: Event) => {
      store.project.env.hour = Number((e.target as HTMLInputElement).value);
      syncEnv();
      world.applyEnv();
    },
    onchange: () => store.notify({ type: 'env' }),
  });
  const month = h('select', {
    title: 'Mes (altura del sol)',
    style: 'width:auto',
    onchange: (e: Event) => store.edit(() => (store.project.env.month = Number((e.target as HTMLSelectElement).value)), { type: 'env' }),
  });
  ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'].forEach((m, i) => month.append(h('option', { value: i + 1 }, m)));
  const wet = h('button', {
    class: 'icon-btn',
    title: 'Calzada mojada',
    html: ICON.drop,
    onclick: () => store.edit(() => (store.project.env.wet = !store.project.env.wet), { type: 'env' }),
  });
  const fog = h('input', {
    type: 'range',
    min: 0,
    max: 1,
    step: 0.05,
    title: 'Niebla',
    style: 'width:70px',
    oninput: (e: Event) => {
      store.project.env.fog = Number((e.target as HTMLInputElement).value);
      world.applyEnv();
    },
    onchange: () => store.notify({ type: 'env' }),
  });
  const saveState = h('span', { class: 'save-state' }, '');
  store.onSaved = (ok) => {
    saveState.textContent = ok ? 'Guardado' : 'Sin guardar';
  };

  const syncEnv = () => {
    const e = store.project.env;
    hour.value = String(e.hour);
    const hh = Math.floor(e.hour);
    const mm = Math.round((e.hour - hh) * 60);
    hourOut.textContent = `${String(hh % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    month.value = String(e.month);
    fog.value = String(e.fog);
    wet.classList.toggle('toggled', e.wet);
    name.value = store.project.name;
    undo.disabled = !store.canUndo();
    redo.disabled = !store.canRedo();
  };
  store.on(() => syncEnv());
  void env;

  bar.append(
    h('div', { class: 'brand' }, h('span', { class: 'logo', html: ICON.road }), 'Catacrash'),
    name,
    h('span', { class: 'sep' }),
    h('button', {
      class: 'icon-btn',
      title: 'Nuevo escenario: desde una carretera tipo, una captura, fotos, un croquis o un lugar real',
      html: ICON.file,
      onclick: () => openStartWizard(ed, { openFile }),
    }),
    h('button', {
      class: 'icon-btn',
      title: 'Abrir escenario (.json)',
      html: ICON.open,
      onclick: () => openFile(),
    }),
    h('button', {
      class: 'icon-btn',
      title: 'Exportar escenario (.json)',
      html: ICON.save,
      onclick: () => {
        const safe = store.project.name.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '').trim() || 'escenario';
        download(`${safe}.catacrash.json`, serialize(store.project, store.assets));
      },
    }),
    h('span', { class: 'sep' }),
    undo,
    redo,
    h('span', { class: 'sep' }),
    h('button', { class: 'icon-btn', title: 'Vista en planta (P)', html: ICON.top, onclick: () => ed.vp.topView() }),
    h('button', {
      class: 'icon-btn',
      title: 'Vista 3D general',
      html: ICON.persp,
      onclick: () => {
        ed.vp.controls.target.set(0, 0, 0);
        ed.vp.camera.position.set(-70, 60, 95);
      },
    }),
    h('button', {
      class: 'icon-btn',
      title: 'Capturar imagen (PNG)',
      html: ICON.image,
      onclick: () => {
        ed.vp.renderer.domElement.toBlob((b) => b && download('captura.png', b, 'image/png'));
      },
    }),
    h('button', { class: 'icon-btn', title: 'Informe del accidente: cronología, causas y evitabilidad', html: ICON.report, onclick: () => openReport(ed) }),
    h('span', { class: 'spacer' }),
    h(
      'div',
      { class: 'env' },
      h('span', { html: ICON.sun, title: 'Hora y mes' }),
      hour,
      hourOut,
      month,
      h('span', { class: 'sep' }),
      wet,
      h('span', { title: 'Niebla' }, 'Niebla'),
      fog,
    ),
    h('span', { class: 'sep' }),
    saveState,
    h('button', {
      class: 'icon-btn',
      title: 'Ayuda',
      html: ICON.help,
      onclick: () => showHelp(store),
    }),
  );
  syncEnv();
}

function showHelp(store: Store) {
  const close = () => ov.remove();
  const ov: HTMLDivElement = h(
    'div',
    { class: 'help-overlay', onclick: (e: Event) => e.target === ov && close() },
    h(
      'div',
      { class: 'help-card' },
      h('h2', {}, 'Catacrash · editor de escenarios'),
      h(
        'p',
        { class: 'muted' },
        'Recrea el lugar del accidente a escala real. Flujo recomendado: 1) carga la ortofoto o una captura del lugar y el croquis como calcos, 2) calibra su escala, 3) dibuja la carretera encima y ajusta su sección, 4) modela desniveles, 5) añade muros, vallas, árboles, señales y mobiliario. Todo se guarda automáticamente en este navegador.',
      ),
      shortcuts([
        ['V', 'Seleccionar y editar'],
        ['C', 'Dibujar carretera'],
        ['U', 'Glorieta'],
        ['B', 'Áreas: ensanches de cruces, isletas, explanadas'],
        ['A', 'Dibujar río / cauce'],
        ['L', 'Elementos lineales (muro, valla, guardarraíl, tendido…)'],
        ['H', 'Vehículos y peatones (catálogo, genéricos, ficha técnica)'],
        ['O', 'Colocar objetos (árboles, señales, farolas…)'],
        ['T', 'Modelar terreno'],
        ['K', 'Calcos (croquis, capturas, ortofoto)'],
        ['I', 'Fotos de referencia y coincidencia de cámara'],
        ['M', 'Medir'],
        ['P / F', 'Vista en planta / encuadrar selección'],
        ['Ctrl+Z / Ctrl+Y', 'Deshacer / rehacer'],
      ]),
      h(
        'div',
        { class: 'row', style: 'margin-top:14px' },
        h(
          'button',
          {
            class: 'btn',
            onclick: () => {
              const d = demoProject();
              store.load(d.project, d.assets);
              close();
              toast('Escenario de ejemplo cargado.');
            },
          },
          'Cargar escenario de ejemplo',
        ),
        h('button', { class: 'btn primary', onclick: close }, 'Cerrar'),
      ),
    ),
  );
  document.body.append(ov);
}

function buildStatus(ed: Editor, store: Store) {
  const el = document.getElementById('status')!;
  const hint = h('span', { class: 'hint' }, ed.tool.hint);
  const coords = h('span', { class: 'coords' }, '');
  el.append(hint, coords);
  let tmp = 0;
  ed.onToolChange((t) => (hint.textContent = t.hint));
  ed.setHint = (s: string) => {
    hint.textContent = s;
    clearTimeout(tmp);
    tmp = window.setTimeout(() => (hint.textContent = ed.tool.hint), 2500);
  };
  ed.onCursor((p) => {
    if (!p) {
      coords.textContent = '';
      return;
    }
    const g = store.project.geo;
    let s = `X ${fmt(p.x, 2)}  Z ${fmt(p.z, 2)}  cota ${fmt(p.y + (g?.h0 ?? 0), 2)} m`;
    if (g) {
      const u = sceneToUtm(g, p.x, p.z);
      s += `  ·  UTM ${g.epsg - 25800}N  ${fmt(u.e, 1)}  ${fmt(u.n, 1)}`;
    }
    coords.textContent = s;
  });
}

boot().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) l.textContent = 'Error al iniciar: ' + (e as Error).message;
});
