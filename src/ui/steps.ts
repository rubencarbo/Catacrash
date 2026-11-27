import type { Editor } from '../editor';
import type { VehicleEntity } from '../model/types';
import { ROLES } from '../physics/marks';
import { clear, h } from './dom';
import { openFitDialog } from './fitDialog';
import { openReport } from './reportDialog';
import { openStartWizard } from './startWizard';

interface Step {
  id: string;
  label: string;
  done: () => boolean;
  next: string;
  /** Contenido de la ayuda del paso (se construye al abrirlo). */
  body: () => (Node | string)[];
}

/**
 * Pasos guiados en la parte superior del visor, en el orden en que conviene trabajar:
 * 1 Lugar → 2 Croquis y fotos → 3 Vehículos (posiciones ① ② ③) → 4 Velocidades → 5 Ver e informe.
 * Cada paso explica qué hacer y cuándo, y tiene botones que lo hacen.
 */
export function buildSteps(ed: Editor, host: HTMLElement, openFile: () => void) {
  let hidden = false;
  try {
    hidden = localStorage.getItem('catacrash.steps') === 'off';
  } catch {
    /* sin almacenamiento */
  }
  let open: string | null = null;
  let refsSkipped = false;
  let reportSeen = false;
  const p = () => ed.store.project;
  const vehicles = () => p().entities.filter((e): e is VehicleEntity => e.kind === 'vehicle' && !e.hidden);
  const btn = (label: string, fn: () => void, primary = false) =>
    h(
      'button',
      {
        class: 'btn' + (primary ? ' primary' : ''),
        onclick: () => {
          open = null;
          fn();
          render();
        },
      },
      label,
    );
  const para = (html: string) => h('p', { html });

  const steps: Step[] = [
    {
      id: 'lugar',
      label: 'Lugar',
      done: () => p().entities.some((e) => e.kind === 'road' || e.kind === 'roundabout'),
      next: 'Crea la carretera',
      body: () => [
        para('<b>Empieza siempre por el lugar</b>: los vehículos se colocan después, encima de la carretera.'),
        para('Elige una <b>carretera tipo</b> (recta, curva, cruce, glorieta), o <b>calca una captura</b> de Google Maps y dibuja la vía encima. Los puntos naranjas de la carretera se arrastran para ajustar el trazado; su sección (carriles, arcén, aceras) se cambia en el panel derecho.'),
        h('div', { class: 'row wrap' }, btn('Carretera tipo o captura…', () => openStartWizard(ed, { openFile }), true), btn('Dibujar la carretera', () => ed.setTool('road'))),
      ],
    },
    {
      id: 'refs',
      label: 'Croquis y fotos',
      done: () => refsSkipped || p().entities.some((e) => e.kind === 'overlay' || e.kind === 'photo'),
      next: 'Añade el croquis o las fotos',
      body: () => [
        para('<b>Opcional, pero ayuda mucho</b>: sirven de guía para dibujar el lugar y colocar los vehículos.'),
        para('• <b>Croquis del atestado</b> o captura aérea: se pone en el suelo como un calco (el papel blanco se vuelve transparente). Después marcas dos puntos de una medida conocida para ponerlo a escala.<br>• <b>Fotos del lugar</b> o de Street View: haces clic donde se tomó y la giras hasta que encaje con la escena.<br>• También puedes <b>pegar</b> cualquier imagen con Ctrl+V.'),
        h(
          'div',
          { class: 'row wrap' },
          btn('Añadir croquis o captura', () => ed.setTool('overlay'), true),
          btn('Añadir foto del lugar', () => ed.setTool('photo')),
          btn('No tengo · saltar', () => (refsSkipped = true)),
        ),
      ],
    },
    {
      id: 'vehiculos',
      label: 'Vehículos',
      done: () => vehicles().length > 0 && vehicles().every((v) => !!v.marks?.col || (!v.marks && !!v.drive)),
      next: 'Coloca los vehículos',
      body: () => {
        const list = h('div', { class: 'steps-list' });
        for (const v of vehicles()) {
          const row = h('div', { class: 'sl-row' }, h('span', { class: 'dot', style: `background:${v.color}` }), h('strong', {}, v.label));
          for (const r of ['ini', 'col', 'fin'] as const) {
            const set = !!v.marks?.[r];
            row.append(
              h(
                'button',
                {
                  class: `qb-chip mark-${r}` + (set ? ' on' : ' empty'),
                  title: set ? `${ROLES[r].long} colocada` : `Colocar: ${ROLES[r].help}`,
                  onclick: () => {
                    open = null;
                    if (set) ed.selectMark(v.id, r);
                    else ed.placeMark?.(v.id, r);
                    render();
                  },
                },
                ROLES[r].n,
              ),
            );
          }
          list.append(row);
        }
        return [
          para('Para cada vehículo implicado, marca sus posiciones <b>como en el croquis del atestado</b>:'),
          h(
            'div',
            { class: 'steps-roles' },
            h('span', {}, h('b', { class: 'rb-n mark-col' }, '2'), ' En el choque: dónde estaba en el instante del impacto (la más importante).'),
            h('span', {}, h('b', { class: 'rb-n mark-ini' }, '1'), ' Inicial: dónde estaba al empezar, cuando apareció el peligro.'),
            h('span', {}, h('b', { class: 'rb-n mark-fin' }, '3'), ' Final: dónde quedó parado.'),
          ),
          para('Elige el vehículo (tipo o modelo) y haz clic donde estaba; si <b>pulsas y arrastras</b>, marcas hacia dónde iba. La app te pide una posición tras otra; si no sabes alguna, sáltala. Luego cada posición se puede <b>arrastrar</b> y <b>girar</b> con su icono ↻.'),
          vehicles().length ? list : '',
          h('div', { class: 'row wrap' }, btn('Añadir vehículo', () => ed.setTool('vehicle'), true)),
        ];
      },
    },
    {
      id: 'velocidades',
      label: 'Velocidades',
      done: () => !!ed.world.sim?.contacts.some((c) => c.peakForce > 2000),
      next: 'Indica velocidades',
      body: () => [
        para('La app calcula el movimiento: cada vehículo recorre su camino de ① a ② <b>siguiendo la carretera</b> y está en ② justo en el instante del choque; después, la física decide el choque, las huellas, los daños y dónde quedan.'),
        para('• Si <b>sabes la velocidad</b> o si <b>frenó</b>, indícalo en el panel del vehículo.<br>• Si conoces <b>dónde quedaron (③)</b>, «Averiguar velocidades» busca las que reproducen esas posiciones.<br>• En la barra de tiempo puedes añadir frenadas o volantazos con doble clic en la pista de cada vehículo.'),
        h(
          'div',
          { class: 'row wrap' },
          btn('Averiguar velocidades…', () => openFitDialog(ed), true),
          btn('Ver el choque', () => {
            const r = ed.player?.range();
            if (r) ed.player?.setTime(r.start);
            ed.player?.play();
          }),
        ),
      ],
    },
    {
      id: 'informe',
      label: 'Ver e informe',
      done: () => reportSeen,
      next: 'Míralo y genera el informe',
      body: () => [
        para('Reproduce el accidente (Espacio), cambia la cámara (libre, seguir vehículo, vista del conductor) y graba el vídeo con el botón rojo de la barra de tiempo.'),
        para('El <b>informe</b> explica la cronología, las causas (velocidad, invasión de carril, visibilidad, reacción) y si se podía evitar, con imágenes en planta. Se imprime o se guarda en PDF.'),
        h(
          'div',
          { class: 'row wrap' },
          btn('Abrir informe', () => ((reportSeen = true), openReport(ed)), true),
          btn('Reproducir', () => ed.player?.play()),
        ),
      ],
    },
  ];

  const el = h('div', { class: 'steps' });
  const pop = h('div', { class: 'steps-pop' });
  const show = h('button', { class: 'steps-show', title: 'Mostrar los pasos guiados', onclick: () => setHidden(false) }, 'Pasos');
  host.append(el, pop, show);
  const setHidden = (v: boolean) => {
    hidden = v;
    try {
      localStorage.setItem('catacrash.steps', v ? 'off' : 'on');
    } catch {
      /* sin almacenamiento */
    }
    render();
  };

  const render = () => {
    clear(el);
    clear(pop);
    el.style.display = hidden ? 'none' : 'flex';
    show.style.display = hidden ? 'block' : 'none';
    pop.style.display = 'none';
    if (hidden) return;
    const current = steps.find((s) => !s.done()) ?? null;
    steps.forEach((s, i) => {
      const done = s.done();
      el.append(
        h(
          'button',
          {
            class: 'step' + (done ? ' done' : '') + (s === current ? ' current' : '') + (open === s.id ? ' open' : ''),
            onclick: () => {
              open = open === s.id ? null : s.id;
              render();
            },
          },
          h('span', { class: 'step-n' }, done ? '✓' : String(i + 1)),
          s.label,
        ),
      );
      if (i < steps.length - 1) el.append(h('span', { class: 'step-sep' }));
    });
    if (current) el.append(h('button', { class: 'step-next', onclick: () => ((open = current.id), render()) }, `→ ${current.next}`));
    else el.append(h('span', { class: 'step-next ok' }, 'Reconstrucción completa'));
    el.append(h('button', { class: 'step-x', title: 'Ocultar los pasos', onclick: () => setHidden(true) }, '×'));
    const s = steps.find((x) => x.id === open);
    if (s) {
      pop.style.display = 'block';
      pop.append(h('div', { class: 'pop-title' }, `${steps.indexOf(s) + 1}. ${s.label}`), ...s.body());
    }
  };
  ed.store.on(() => render());
  ed.store.onSelect(() => open && render());
  const prev = ed.world.onSim;
  ed.world.onSim = () => {
    prev?.();
    render();
  };
  render();
}
