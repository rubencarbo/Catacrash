type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined | null>;
type Child = Node | string | null | undefined | false;

/** Crea un elemento DOM de forma concisa. Los atributos `on*` se registran como eventos. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return el;
}

export function clear(el: HTMLElement) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmt(v: number, d = 2) {
  return v.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Aviso breve en pantalla. */
export function toast(msg: string, kind: 'info' | 'error' = 'info', ms = 3500) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const t = h('div', { class: `toast ${kind}` }, msg);
  host.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

/** Diálogo de confirmación propio (window.confirm no funciona en algunos entornos incrustados). */
export function confirmDialog(title: string, message: string, ok = 'Aceptar'): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      ov.remove();
      resolve(v);
    };
    const ov: HTMLDivElement = h(
      'div',
      { class: 'help-overlay', onclick: (e: Event) => e.target === ov && done(false) },
      h(
        'div',
        { class: 'help-card', style: 'width:min(460px,92vw)' },
        h('h2', {}, title),
        h('p', { class: 'muted' }, message),
        h(
          'div',
          { class: 'row', style: 'justify-content:flex-end;margin-top:14px' },
          h('button', { class: 'btn', onclick: () => done(false) }, 'Cancelar'),
          h('button', { class: 'btn primary', onclick: () => done(true) }, ok),
        ),
      ),
    );
    document.body.append(ov);
    (ov.querySelector('.btn.primary') as HTMLButtonElement).focus();
  });
}
