import type { Editor, Tool } from '../editor';
import { newId } from '../model/store';
import type { RoundaboutEntity } from '../model/types';
import { h } from '../ui/dom';
import { ICON } from '../ui/icons';

/** Colocación de glorietas con un clic. */
export function roundaboutTool(ed: Editor): Tool {
  const o = { radius: 18, width: 8, lanes: 2 };
  const num = (label: string, key: keyof typeof o, min: number, max: number, step: number, unit: string) =>
    h(
      'label',
      { class: 'field' },
      h('span', {}, label),
      h('input', { type: 'number', min, max, step, value: o[key], onchange: (e: Event) => (o[key] = Number((e.target as HTMLInputElement).value)) }),
      h('output', {}, unit),
    );
  return {
    id: 'roundabout',
    label: 'Glorieta',
    icon: ICON.roundabout,
    key: 'u',
    hint: 'Clic: colocar glorieta · Después arrastra su centro o su radio',
    click(ev) {
      if (!ev.ground) return;
      const n = ed.store.project.entities.filter((e) => e.kind === 'roundabout').length + 1;
      const e: RoundaboutEntity = {
        id: newId('g'),
        kind: 'roundabout',
        name: `Glorieta ${n}`,
        cx: ev.ground.x,
        cz: ev.ground.z,
        h: null,
        radius: o.radius,
        width: o.width,
        lanes: o.lanes,
        apron: 1.5,
        island: 'hierba',
        outer: 'arcen',
        outerWidth: 1,
        talud: 4,
      };
      ed.store.add(e);
      ed.setTool('select');
      ed.select(e.id);
    },
    options(el) {
      el.append(
        num('Radio exterior', 'radius', 6, 80, 0.5, 'm'),
        num('Ancho de calzada', 'width', 4, 16, 0.25, 'm'),
        num('Carriles', 'lanes', 1, 3, 1, ''),
        h(
          'p',
          { class: 'muted' },
          'Haz clic en el centro de la glorieta. Las carreteras que terminen dentro de ella se recortan solas en el anillo y enlazan con su cota.',
        ),
      );
    },
  };
}
