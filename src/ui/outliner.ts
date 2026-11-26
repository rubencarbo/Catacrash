import type { Editor } from '../editor';
import type { EntityKind } from '../model/types';
import { clear, h } from './dom';
import { ICON } from './icons';

const GROUPS: [EntityKind, string, string][] = [
  ['overlay', 'Calcos', ICON.image],
  ['photo', 'Fotos de referencia', ICON.camera],
  ['road', 'Carreteras', ICON.road],
  ['roundabout', 'Glorietas', ICON.roundabout],
  ['area', 'Áreas e isletas', ICON.area],
  ['river', 'Ríos', ICON.river],
  ['linear', 'Elementos lineales', ICON.linear],
  ['prop', 'Objetos', ICON.props],
];

/** Lista jerárquica de elementos de la escena. */
export class Outliner {
  private collapsed = new Set<EntityKind>(['prop']);
  private filter = '';

  constructor(
    private el: HTMLElement,
    private ed: Editor,
  ) {
    ed.store.on((c) => {
      if (c.type !== 'terrain' && c.type !== 'env') this.render();
    });
    ed.store.onSelect(() => this.render());
    this.render();
  }

  render() {
    const el = this.el;
    const scrollTop = el.querySelector('.outline-list')?.scrollTop ?? 0;
    clear(el);
    const ents = this.ed.store.project.entities;
    const sel = this.ed.store.selection?.id;
    const search = h('input', {
      type: 'search',
      class: 'search',
      placeholder: `Buscar en ${ents.length} elementos…`,
      value: this.filter,
      oninput: (e: Event) => {
        this.filter = (e.target as HTMLInputElement).value.toLowerCase();
        this.render();
        const s = this.el.querySelector('input.search') as HTMLInputElement;
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      },
    });
    const list = h('div', { class: 'outline-list' });
    for (const [kind, label, icon] of GROUPS) {
      const items = ents.filter((e) => e.kind === kind && (!this.filter || e.name.toLowerCase().includes(this.filter)));
      if (!items.length) continue;
      const open = !this.collapsed.has(kind) || !!this.filter || items.some((i) => i.id === sel);
      list.append(
        h(
          'button',
          {
            class: 'group' + (open ? ' open' : ''),
            onclick: () => {
              if (this.collapsed.has(kind)) this.collapsed.delete(kind);
              else this.collapsed.add(kind);
              this.render();
            },
          },
          h('span', { class: 'gi', html: icon }),
          label,
          h('span', { class: 'count' }, String(items.length)),
        ),
      );
      if (!open) continue;
      for (const e of items) {
        list.append(
          h(
            'div',
            { class: 'item' + (e.id === sel ? ' selected' : '') + (e.hidden ? ' hidden' : ''), onclick: () => this.ed.select(e.id), ondblclick: () => this.ed.focusSelection() },
            h('span', { class: 'name' }, e.name),
            h('button', {
              class: 'icon-btn small',
              title: e.hidden ? 'Mostrar' : 'Ocultar',
              html: e.hidden ? ICON.eyeOff : ICON.eye,
              onclick: (ev: Event) => {
                ev.stopPropagation();
                this.ed.store.edit(() => (e.hidden = !e.hidden), { type: 'entities' });
              },
            }),
          ),
        );
      }
    }
    if (!list.childElementCount) list.append(h('p', { class: 'muted' }, 'Escena vacía. Empieza cargando un calco o dibujando una carretera.'));
    el.append(h('div', { class: 'panel-title' }, 'Escena'), search, list);
    list.scrollTop = scrollTop;
  }
}
