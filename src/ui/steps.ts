import type { Editor } from '../editor';
import { giveMotionAll, markImpact } from './actions';
import { clear, h } from './dom';
import { openFitDialog } from './fitDialog';
import { openReport } from './reportDialog';
import { openStartWizard } from './startWizard';

interface Step {
  id: string;
  label: string;
  done: () => boolean;
  next: string;
  help: string;
  actions: [string, () => void, boolean?][];
}

/**
 * Pasos guiados en la parte superior del visor: Lugar → Vehículos → Movimiento → Choque → Informe.
 * Cada paso muestra si está hecho, qué hacer y botones que lo hacen por el usuario.
 */
export function buildSteps(ed: Editor, host: HTMLElement, openFile: () => void) {
  let hidden = false;
  try {
    hidden = localStorage.getItem('catacrash.steps') === 'off';
  } catch {
    /* sin almacenamiento */
  }
  let open: string | null = null;
  let reportSeen = false;
  const p = () => ed.store.project;
  const vehicles = () => p().entities.filter((e) => e.kind === 'vehicle' && !e.hidden);
  const steps: Step[] = [
    {
      id: 'lugar',
      label: 'Lugar',
      done: () => p().entities.some((e) => e.kind === 'road' || e.kind === 'roundabout' || e.kind === 'overlay'),
      next: 'Crea la carretera',
      help: 'Recrea el lugar: elige una carretera tipo, calca una captura de Google Maps o un croquis, o dibuja la vía punto a punto. Los puntos naranjas de la carretera se arrastran para ajustarla.',
      actions: [
        ['Plantillas, capturas, fotos…', () => openStartWizard(ed, { openFile }), true],
        ['Dibujar carretera', () => ed.setTool('road')],
        ['Cargar un calco', () => ed.setTool('overlay')],
      ],
    },
    {
      id: 'vehiculos',
      label: 'Vehículos',
      done: () => vehicles().length >= 1,
      next: 'Añade los vehículos',
      help: 'Elige un tipo (o un modelo del catálogo) y haz clic en la vía: se alinea solo con el carril. Si pulsas y arrastras, marcas el sentido de la marcha. Luego arrástralo para moverlo y gíralo con su flecha naranja.',
      actions: [['Añadir vehículo', () => ed.setTool('vehicle'), true]],
    },
    {
      id: 'movimiento',
      label: 'Movimiento',
      done: () => vehicles().some((e) => e.kind === 'vehicle' && !!e.drive),
      next: 'Dales movimiento',
      help: 'Cada vehículo seguirá su carril a 50 km/h. Después, en el inspector (o en su barra), cambia la velocidad, añade frenadas o volantazos y arrastra los puntos de su ruta.',
      actions: [['Dar movimiento a todos', () => giveMotionAll(ed), true]],
    },
    {
      id: 'choque',
      label: 'Choque',
      done: () => !!ed.world.sim?.contacts.some((c) => c.peakForce > 2000),
      next: 'Marca el punto de colisión',
      help: 'Haz clic donde chocaron (la X del croquis): los vehículos llegarán a ese punto a la vez y la física calcula el choque, las huellas, los daños y dónde quedan. Si conoces dónde acabaron, «Ajustar a los hechos» busca las velocidades.',
      actions: [
        ['Marcar punto de colisión', () => markImpact(ed), true],
        ['Ver el choque', () => {
          const r = ed.player?.range();
          if (r) ed.player?.setTime(Math.max(r.start, -2));
          ed.player?.play();
        }],
        ['Ajustar a los hechos…', () => openFitDialog(ed)],
      ],
    },
    {
      id: 'informe',
      label: 'Informe',
      done: () => reportSeen,
      next: 'Genera el informe',
      help: 'Cronología, causas, visibilidad, tiempos de reacción, si se podía evitar e imágenes en planta. Se puede imprimir o guardar en PDF; el vídeo se graba con el botón rojo de la barra de tiempo.',
      actions: [['Abrir informe', () => ((reportSeen = true), openReport(ed), render()), true]],
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
            title: s.help,
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
    if (current)
      el.append(
        h(
          'button',
          { class: 'step-next', onclick: () => ((open = current.id), render()) },
          `→ ${current.next}`,
        ),
      );
    else el.append(h('span', { class: 'step-next ok' }, 'Reconstrucción completa'));
    el.append(h('button', { class: 'step-x', title: 'Ocultar los pasos', onclick: () => setHidden(true) }, '×'));
    const s = steps.find((x) => x.id === open);
    if (s) {
      pop.style.display = 'block';
      pop.append(
        h('div', { class: 'pop-title' }, `${steps.indexOf(s) + 1}. ${s.label}`),
        h('p', {}, s.help),
        h(
          'div',
          { class: 'row wrap' },
          ...s.actions.map(([label, fn, primary]) =>
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
            ),
          ),
        ),
      );
    }
  };
  ed.store.on(() => render());
  const prev = ed.world.onSim;
  ed.world.onSim = () => {
    prev?.();
    render();
  };
  render();
}
