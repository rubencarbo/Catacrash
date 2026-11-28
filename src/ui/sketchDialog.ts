import type { Editor } from '../editor';
import { getApiKey, readSketch, setApiKey, visionMode, VisionError } from '../sketch/ai';
import { projectFromSketch } from '../sketch/interpret';
import type { SketchResult } from '../sketch/schema';
import { addOverlay, readImage } from '../tools/overlayTool';
import * as THREE from 'three';
import { clear, h, toast } from './dom';

const ROLE_TXT: Record<string, string> = { ini: '① inicial', col: '② choque', fin: '③ final', mid: 'intermedia' };

interface Opts {
  name?: string;
  /** Hay un escenario con contenido que se sustituirá. */
  replaces?: boolean;
}

/**
 * «Leer el croquis»: la IA interpreta el dibujo (vías, vehículos con sus posiciones, punto de
 * colisión, señales, textos) y la app monta el escenario a escala con el croquis como calco.
 */
export function openSketchReader(ed: Editor, image: Blob, opts: Opts = {}) {
  const ov: HTMLDivElement = h('div', { class: 'help-overlay sketch-overlay' });
  const card = h('div', { class: 'help-card sketch-card' });
  ov.append(card);
  document.body.append(ov);
  const preview = URL.createObjectURL(image);
  let abort: AbortController | null = null;
  const close = () => {
    abort?.abort();
    URL.revokeObjectURL(preview);
    ov.remove();
  };

  /** Solo como calco (lo de antes): imagen transparente y calibrar escala a mano. */
  const asTracing = async () => {
    close();
    const { url, aspect } = await readImage(image, true);
    const t0 = ed.vp.controls.target;
    const o = addOverlay(ed, url, aspect, `Croquis: ${opts.name ?? 'imagen'}`, 60, t0.x, t0.z);
    ed.store.edit(() => (o.onRoads = true), { type: 'entity', id: o.id });
    ed.calibrateOverlay?.(o.id);
    toast('Pon el croquis a escala: clic en dos puntos de una distancia conocida y escribe cuánto mide.', 'info', 8000);
  };

  const img = () => h('div', { class: 'paste-preview' }, h('img', { src: preview, alt: 'Croquis' }));

  const intro = async () => {
    clear(card);
    const mode = await visionMode();
    card.append(h('h2', {}, 'Leer el croquis'), img());
    if (mode === 'none') {
      const key = h('input', { type: 'password', placeholder: 'sk-ant-…', value: getApiKey(), autocomplete: 'off' });
      card.append(
        h('p', {}, 'Para que la app lea el dibujo e interprete sus elementos necesita a Claude, que ve la imagen.'),
        h(
          'ul',
          { class: 'muted sketch-list' },
          h('li', {}, 'Abriendo la app desde claude.ai funciona sin más: te pedirá permiso la primera vez.'),
          h('li', {}, 'En tu propia instalación, guarda una clave de la API de Anthropic (se queda solo en este navegador).'),
        ),
        h('label', { class: 'field wide' }, h('span', {}, 'Clave de la API'), key),
        h(
          'div',
          { class: 'row end' },
          h('button', { class: 'btn', onclick: asTracing }, 'Solo como calco'),
          h('button', { class: 'btn', onclick: close }, 'Cancelar'),
          h('button', { class: 'btn primary', onclick: () => (key.value.trim() ? (setApiKey(key.value.trim()), run()) : toast('Escribe la clave o usa «Solo como calco».', 'error')) }, 'Guardar y leer'),
        ),
      );
      return;
    }
    card.append(
      h('p', {}, 'Claude mirará el dibujo y reconocerá las vías y el cruce, cada vehículo con sus posiciones (1 inicial, 2 choque, 3 final o PF), el punto de colisión (PC), las señales (STOP, ceda…) y los textos. Con eso se monta el escenario a escala real y el croquis queda debajo como calco para comparar.'),
      h('p', { class: 'muted' }, mode === 'claude' ? 'Se usa Claude con tu cuenta de claude.ai; la primera vez te pedirá permiso para enviar la imagen.' : 'Se usa tu clave de la API de Anthropic.'),
      h(
        'div',
        { class: 'row end' },
        h('button', { class: 'btn', onclick: asTracing }, 'Solo como calco'),
        h('button', { class: 'btn', onclick: close }, 'Cancelar'),
        h('button', { class: 'btn primary big', onclick: run }, 'Leer el croquis'),
      ),
    );
  };

  const run = async () => {
    clear(card);
    abort = new AbortController();
    const status = h('p', { class: 'sketch-status' }, 'Enviando la imagen…');
    const bar = h('div', { class: 'sketch-bar' }, h('i', {}));
    card.append(h('h2', {}, 'Leyendo el croquis…'), img(), bar, status, h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => (abort?.abort(), intro()) }, 'Cancelar')));
    const t0 = performance.now();
    const tick = setInterval(() => {
      const s = Math.round((performance.now() - t0) / 1000);
      if (!status.dataset.chars) status.textContent = `Claude está mirando el dibujo… (${s} s)`;
    }, 1000);
    try {
      const res = await readSketch(
        image,
        (n) => {
          status.dataset.chars = String(n);
          status.textContent = `Interpretando elementos… (${n} caracteres)`;
        },
        abort.signal,
      );
      clearInterval(tick);
      review(res.result, res.width, res.height);
    } catch (e) {
      clearInterval(tick);
      if ((e as VisionError).code === 'cancelled') return;
      if ((e as VisionError).code === 'auth') setApiKey('');
      clear(card);
      card.append(
        h('h2', {}, 'No se pudo leer el croquis'),
        h('p', {}, (e as Error).message),
        h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: asTracing }, 'Solo como calco'), h('button', { class: 'btn', onclick: close }, 'Cerrar'), h('button', { class: 'btn primary', onclick: intro }, 'Volver a intentarlo')),
      );
    }
  };

  const review = (r: SketchResult, w: number, hh: number) => {
    clear(card);
    const li = (t: string) => h('li', {}, t);
    const roads = r.roads.map((x) => li(`${x.name || (x.main ? 'Vía principal' : 'Vía')}${x.main ? ' (principal)' : ''} · ${x.lanes ?? 2} carriles${x.direction_note ? ` · ${x.direction_note}` : ''}`));
    const veh = r.vehicles.map((v) => li(`${v.label} (${v.type}${v.description ? `, ${v.description}` : ''}): ${v.positions.map((p) => `${p.tag || '?'} → ${ROLE_TXT[p.role]}`).join(' · ')}`));
    const other: string[] = [];
    if (r.impact) other.push('Punto de colisión (PC)');
    for (const s of r.signs ?? []) other.push(`Señal ${s.type.toUpperCase()}${s.value ? ` ${s.value}` : ''}`);
    for (const m of r.markings ?? []) other.push(m.type.replace(/_/g, ' '));
    for (const o of r.objects ?? []) other.push(o.label || o.type);
    const texts = (r.texts ?? []).map((t) => li(`«${t.text}»`));
    const sec = (title: string, items: HTMLElement[]) => (items.length ? h('div', { class: 'sketch-sec' }, h('strong', {}, title), h('ul', { class: 'sketch-list' }, ...items)) : null);
    card.append(
      ...[
      h('h2', {}, 'Esto es lo que dice el croquis'),
      r.summary ? h('p', { class: 'sketch-summary' }, r.summary) : null,
      h('div', { class: 'sketch-cols' }, h('div', {}, sec('Vías', roads), sec('Vehículos', veh)), h('div', {}, sec('Otros elementos', other.map(li)), sec('Textos', texts))),
      r.uncertainties?.length ? sec('Dudas', r.uncertainties.map(li)) : null,
      h('p', { class: 'muted' }, 'Después podrás arrastrar cualquier posición que no encaje con el calco: la app recalcula el accidente.'),
      h(
        'div',
        { class: 'row end' },
        h('button', { class: 'btn', onclick: intro }, 'Volver a leer'),
        h('button', { class: 'btn', onclick: close }, 'Cancelar'),
        h('button', { class: 'btn primary big', onclick: () => build(r, w, hh) }, opts.replaces ? 'Crear el escenario (sustituye el actual)' : 'Crear el escenario'),
      ),
      ].filter((x): x is NonNullable<typeof x> => !!x),
    );
  };

  const build = async (r: SketchResult, w: number, hh: number) => {
    const { url } = await readImage(image, true);
    close();
    await buildSketchScene(ed, r, w, hh, url, opts.name);
  };

  void intro();
}

/** Monta el escenario a partir de una lectura (también lo usan las pruebas). */
export async function buildSketchScene(ed: Editor, r: SketchResult, w: number, hh: number, imageUrl: string | null, name?: string, opts: { fit?: boolean } = {}) {
  const { project, assets, info } = projectFromSketch(r, w, hh, imageUrl, name);
  ed.store.load(project, assets);
  ed.setTool('select');
  await new Promise((res) => setTimeout(res, 300));
  ed.player?.setTime(ed.player.range().start);
  // encuadre: todas las posiciones del croquis con margen
  const box = new THREE.Box3();
  for (const e of project.entities)
    if (e.kind === 'vehicle')
      for (const m of [e.marks?.ini, e.marks?.col, e.marks?.fin, ...(e.marks?.mid ?? [])]) if (m) box.expandByPoint(new THREE.Vector3(m.x, 0, m.z));
  if (box.isEmpty()) ed.frameAll();
  else ed.vp.frameBox(box.expandByScalar(12));
  const veh = info.vehicles.map((v) => `${v.label} (${v.positions.join(', ')})`).join(' · ');
  toast(`Escenario creado desde el croquis: ${info.roads} vía(s), ${info.vehicles.length} vehículo(s) ${veh ? `— ${veh}` : ''}. Escala: ${info.scale.toFixed(3)} m/px según ${info.scaleFrom}. Revisa las posiciones sobre el calco y arrastra las que no encajen.`, 'info', 14000);
  if (info.warnings.length) setTimeout(() => toast(info.warnings.slice(0, 3).join(' · '), 'info', 12000), 600);
  // las velocidades no las dice el dibujo: se averiguan con las posiciones finales (③ / PF)
  if (opts.fit !== false && project.entities.some((e) => e.kind === 'vehicle' && e.marks?.col && e.marks?.fin)) {
    await new Promise((res) => setTimeout(res, 900));
    const { openFitDialog } = await import('./fitDialog');
    openFitDialog(ed, undefined, { autoRun: true });
  }
  return info;
}
