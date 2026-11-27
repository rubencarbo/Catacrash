import type { CameraMode, Player } from '../anim/player';
import type { Editor } from '../editor';
import { download } from '../io/file';
import { newId } from '../model/store';
import type { DriverEvent, VehicleEntity } from '../model/types';
import { giveMotion } from './actions';
import { clear, fmt, h, toast } from './dom';
import { openFitDialog } from './fitDialog';

const ICONS = {
  play: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>',
  start: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 4h2v16H6zM20 4L9 12l11 8z" fill="currentColor"/></svg>',
  end: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M16 4h2v16h-2zM4 4l11 8-11 8z" fill="currentColor"/></svg>',
  rec: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>',
  fold: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
};

const fmtT = (t: number) => (Math.abs(t) < 0.005 ? '0,00 s' : `${t < 0 ? '−' : '+'}${fmt(Math.abs(t), 2)} s`);

/** Iconos y nombres de las acciones del conductor en las pistas. */
const ACTION_UI: Record<DriverEvent['action'], { icon: (v: number) => string; name: (v: number) => string; cls: string }> = {
  frenar: { icon: () => '■', name: (v) => (v >= 0.95 ? 'Frena a fondo' : `Frena (${Math.round(v * 100)} %)`), cls: 'brake' },
  girar: { icon: (v) => (v < 0 ? '↶' : '↷'), name: (v) => `Volantazo ${Math.abs(v)}° a la ${v < 0 ? 'izquierda' : 'derecha'}`, cls: 'steer' },
  acelerar: { icon: () => '▲', name: (v) => `Acelera (${Math.round(v * 100)} %)`, cls: 'gas' },
  soltar: { icon: () => '○', name: () => 'Suelta los pedales', cls: 'coast' },
  recto: { icon: () => '│', name: () => 'Vuelve a su ruta', cls: 'coast' },
};

/** Acciones que se pueden añadir con doble clic en la pista de un vehículo. */
const ADD_MENU: [string, DriverEvent['action'], number][] = [
  ['Frenar a fondo', 'frenar', 1],
  ['Frenar suave (40 %)', 'frenar', 0.4],
  ['Volantazo a la izquierda', 'girar', -8],
  ['Volantazo a la derecha', 'girar', 8],
  ['Acelerar', 'acelerar', 1],
  ['Soltar los pedales', 'soltar', 0],
  ['Volver a su ruta', 'recto', 0],
];

/**
 * Secuencia del accidente en la parte inferior del visor: controles de reproducción, regla de
 * tiempo con INICIO, IMPACTO y FIN, y una pista por vehículo con su velocidad, las acciones del
 * conductor (arrastrables), las posiciones fijadas, el choque y el reposo. Llevando la línea de
 * tiempo a cualquier instante, el vehículo se arrastra en la escena para colocarlo ahí.
 */
export class TimelineBar {
  el: HTMLElement;
  private label: HTMLElement;
  private playBtn: HTMLButtonElement;
  private speedInfo: HTMLElement;
  private recorder: MediaRecorder | null = null;
  private warn: HTMLElement;
  private grid: HTMLElement;
  private startIn: HTMLInputElement;
  private endIn: HTMLInputElement;
  private heads: HTMLElement[] = [];
  private folded = false;
  private menu: HTMLElement | null = null;
  private dragging = false;

  constructor(
    host: HTMLElement,
    private ed: Editor,
    private player: Player,
  ) {
    try {
      this.folded = localStorage.getItem('catacrash.secuencia') === 'plegada';
    } catch {
      /* sin almacenamiento */
    }
    this.el = h('div', { class: 'timeline' });
    this.playBtn = h('button', { class: 'tl-btn play', title: 'Reproducir / pausa (Espacio)', html: ICONS.play, onclick: () => player.toggle() });
    this.label = h('span', { class: 'tl-time' }, '');
    this.speedInfo = h('span', { class: 'tl-speeds' }, '');
    this.warn = h('span', { class: 'tl-warn' });
    const rate = h('select', { title: 'Velocidad de reproducción', onchange: (e: Event) => (player.rate = Number((e.target as HTMLSelectElement).value)) });
    for (const r of [0.1, 0.25, 0.5, 1, 2]) rate.append(h('option', { value: r, selected: r === 1 }, `${String(r).replace('.', ',')}×`));
    const cam = h('select', { title: 'Cámara', onchange: (e: Event) => player.setCamera((e.target as HTMLSelectElement).value as CameraMode) });
    for (const [k, l] of [
      ['libre', 'Cámara libre'],
      ['seguir', 'Seguir vehículo'],
      ['conductor', 'Vista del conductor'],
    ])
      cam.append(h('option', { value: k }, l));
    const range = player.range();
    this.startIn = h('input', { type: 'number', class: 'tl-range', step: 0.5, max: 0, value: range.start, title: 'Instante de inicio (s, antes del impacto)', onchange: () => this.setRange() });
    this.endIn = h('input', { type: 'number', class: 'tl-range', step: 0.5, min: 0, value: range.end, title: 'Instante final (s, después del impacto)', onchange: () => this.setRange() });
    const foldBtn = h('button', { class: 'tl-btn fold', title: 'Mostrar u ocultar las pistas de los vehículos', html: ICONS.fold, onclick: () => this.setFolded(!this.folded) });
    this.grid = h('div', { class: 'tl-grid' });

    this.el.append(
      h(
        'div',
        { class: 'tl-top' },
        h('button', { class: 'tl-btn', title: 'Ir al INICIO', html: ICONS.start, onclick: () => (player.pause(), player.setTime(player.range().start)) }),
        this.playBtn,
        h('button', { class: 'tl-btn', title: 'Ir al FIN', html: ICONS.end, onclick: () => (player.pause(), player.setTime(player.range().end)) }),
        h('button', { class: 'tl-btn impact', title: 'Ir al instante del impacto (t = 0)', onclick: () => (player.pause(), player.setTime(0)) }, 'Impacto'),
        this.label,
        this.speedInfo,
        this.warn,
        h('span', { class: 'tl-spacer' }),
        h('button', { class: 'tl-btn fit', title: 'Averiguar velocidades y maniobras a partir de lo observado (posición final, daños, huellas)', onclick: () => (player.pause(), openFitDialog(ed)) }, 'Ajustar a los hechos…'),
        rate,
        cam,
        h('button', { class: 'tl-btn rec', title: 'Grabar vídeo de toda la animación (WebM)', html: ICONS.rec, onclick: () => this.record() }),
        foldBtn,
      ),
      this.grid,
    );
    host.append(this.el);
    player.on(() => this.sync());
    ed.store.on(() => this.build());
    const prevSim = ed.world.onSim;
    ed.world.onSim = () => {
      prevSim?.();
      this.build();
      this.checkOverlaps();
    };
    setTimeout(() => this.checkOverlaps(), 300);
    ed.store.onSelect(() => this.build());
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        player.toggle();
      }
    });
    window.addEventListener('pointerdown', (e) => {
      if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
    });
    this.build();
  }

  private setFolded(v: boolean) {
    this.folded = v;
    try {
      localStorage.setItem('catacrash.secuencia', v ? 'plegada' : 'abierta');
    } catch {
      /* sin almacenamiento */
    }
    this.build();
  }

  private setRange() {
    const s = Number(this.startIn.value);
    const e = Number(this.endIn.value);
    if (!(e > s)) return toast('El FIN debe ser posterior al INICIO.', 'error');
    this.ed.store.edit(() => (this.ed.store.project.timeline = { start: Math.min(s, 0), end: Math.max(e, 0) }), { type: 'env' });
  }

  private pct(t: number) {
    const { start, end } = this.player.range();
    return ((t - start) / (end - start)) * 100;
  }
  private timeAt(lane: HTMLElement, clientX: number) {
    const r = lane.getBoundingClientRect();
    const { start, end } = this.player.range();
    const u = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return start + u * (end - start);
  }

  /** Arrastrar sobre la regla o una pista lleva la línea de tiempo a ese instante. */
  private scrubbable(lane: HTMLElement, onStart?: () => void) {
    lane.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('.tl-mk.drag')) return;
      this.player.pause();
      onStart?.();
      try {
        lane.setPointerCapture(e.pointerId);
      } catch {
        /* puntero ya liberado */
      }
      this.player.setTime(this.timeAt(lane, e.clientX));
      const move = (ev: PointerEvent) => this.player.setTime(this.timeAt(lane, ev.clientX));
      const up = () => {
        lane.removeEventListener('pointermove', move);
        lane.removeEventListener('pointerup', up);
      };
      lane.addEventListener('pointermove', move);
      lane.addEventListener('pointerup', up);
    });
  }

  /** Reconstruye la regla y las pistas. */
  private build() {
    if (this.dragging) return;
    const { start, end } = this.player.range();
    if (document.activeElement !== this.startIn) this.startIn.value = String(start);
    if (document.activeElement !== this.endIn) this.endIn.value = String(end);
    clear(this.grid);
    this.heads = [];
    // regla: INICIO · marcas de segundo · IMPACTO · FIN
    const ruler = h('div', { class: 'tl-lane ruler', title: 'Arrastra para ir a cualquier instante' });
    for (let t = Math.ceil(start * 2) / 2; t <= end + 1e-6; t += 0.5) {
      const major = Math.abs(t - Math.round(t)) < 1e-6;
      ruler.append(h('span', { class: 'tl-tick' + (major ? ' major' : ''), style: `left:${this.pct(t)}%` }));
      if (major && Math.abs(t) > 1e-6 && t > start + 0.3 && t < end - 0.3) ruler.append(h('span', { class: 'tl-tick-l', style: `left:${this.pct(t)}%` }, `${t > 0 ? '+' : '−'}${Math.abs(t)}`));
    }
    if (0 >= start && 0 <= end) ruler.append(h('span', { class: 'tl-zero', style: `left:${this.pct(0)}%` }, 'IMPACTO'));
    const head = h('span', { class: 'tl-head' });
    ruler.append(head);
    this.heads.push(head);
    this.scrubbable(ruler);
    this.grid.append(
      h(
        'div',
        { class: 'tl-row' },
        h('label', { class: 'tl-lab start', title: 'Instante en que empieza la reconstrucción' }, h('span', {}, 'INICIO'), this.startIn),
        ruler,
        h('label', { class: 'tl-end', title: 'Instante en que termina' }, h('span', {}, 'FIN'), this.endIn),
      ),
    );

    // pistas de los vehículos
    const vehicles = this.ed.store.project.entities.filter((e): e is VehicleEntity => e.kind === 'vehicle' && !e.hidden);
    if (!this.folded)
      for (const v of vehicles) this.grid.append(this.track(v));
    if (!this.folded && vehicles.length)
      this.grid.append(
        h('div', { class: 'tl-hint' }, 'Lleva la línea de tiempo a cualquier instante y arrastra el vehículo en la escena para colocarlo ahí · Doble clic en una pista: añadir acción del conductor · Arrastra los iconos para cambiar su instante · Clic derecho: quitar'),
      );
    this.el.classList.toggle('folded', this.folded);
    this.sync();
  }

  private track(v: VehicleEntity) {
    const sel = this.ed.store.selection?.id === v.id;
    const sv = this.ed.world.sim?.vehicles.get(v.id);
    const { start, end } = this.player.range();
    const lane = h('div', { class: 'tl-lane veh' + (sel ? ' sel' : '') });
    // velocidad (fondo de la pista)
    if (sv) {
      const vmax = Math.max(10, ...sv.frames.map((f) => f.v));
      const pts = sv.frames
        .filter((f, i) => i % 3 === 0 && f.t >= start && f.t <= end)
        .map((f) => `${(((f.t - start) / (end - start)) * 1000).toFixed(1)},${(22 - (f.v / vmax) * 18).toFixed(1)}`)
        .join(' ');
      lane.append(h('span', { class: 'tl-spark', html: `<svg viewBox="0 0 1000 24" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="${v.color}" stroke-width="1.6" vector-effect="non-scaling-stroke" opacity=".75"/></svg>` }));
    }
    const mk = (t: number, text: string, cls: string, title: string) => h('span', { class: `tl-mk ${cls}`, style: `left:${this.pct(t)}%`, title }, text);
    // choque y reposo
    if (sv?.firstContact != null) lane.append(mk(sv.firstContact, '✸', 'hit', `Primer contacto · ${fmtT(sv.firstContact)}`));
    if (sv?.restTime != null && sv.restTime <= end) lane.append(mk(sv.restTime, 'P', 'rest', `Queda parado · ${fmtT(sv.restTime)}`));
    // acciones del conductor (arrastrables)
    for (const ev of v.drive?.events ?? []) {
      const ui = ACTION_UI[ev.action];
      const m = mk(ev.t, ui.icon(ev.value), `drag act ${ui.cls}`, `${ui.name(ev.value)} · ${fmtT(ev.t)} — arrastra para cambiar el instante, clic derecho para quitar`);
      this.draggableTime(m, lane, (t) => this.ed.store.edit(() => (ev.t = t), { type: 'env' }), () => this.ed.store.edit(() => (v.drive!.events = v.drive!.events.filter((x) => x !== ev)), { type: 'env' }));
      lane.append(m);
    }
    // posiciones fijadas (arrastrables)
    for (const pn of v.pins ?? []) {
      const m = mk(pn.t, '◆', 'drag pin', `Posición observada · ${fmtT(pn.t)} — arrastra para cambiar el instante, clic derecho para quitar`);
      this.draggableTime(m, lane, (t) => this.ed.store.edit(() => (pn.t = t), { type: 'env' }), () => this.ed.store.edit(() => (v.pins = (v.pins ?? []).filter((x) => x !== pn)), { type: 'env' }));
      lane.append(m);
    }
    // iconos muy próximos: escalonados en altura para poder agarrar cada uno
    const mks = [...lane.querySelectorAll<HTMLElement>('.tl-mk')].sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left));
    let prev: HTMLElement | null = null;
    let level = 0;
    for (const m of mks) {
      const x = parseFloat(m.style.left);
      level = prev && x - parseFloat(prev.style.left) < 2.6 ? level + 1 : 0;
      if (level && prev) {
        // el anterior arriba y este abajo (y así sucesivamente)
        if (level === 1) prev.style.top = '27%';
        m.style.top = level % 2 ? '73%' : '27%';
        lane.classList.add('tall');
      }
      prev = m;
    }
    const head = h('span', { class: 'tl-head' });
    lane.append(head);
    this.heads.push(head);
    this.scrubbable(lane, () => this.ed.store.selection?.id !== v.id && this.ed.select(v.id));
    lane.addEventListener('dblclick', (e) => this.openMenu(v, this.timeAt(lane, (e as MouseEvent).clientX), e as MouseEvent));
    lane.addEventListener('contextmenu', (e) => e.preventDefault());
    const speed = h('span', { class: 'tl-end v' });
    speed.dataset.veh = v.id;
    return h(
      'div',
      { class: 'tl-row' },
      h(
        'button',
        { class: 'tl-lab veh' + (sel ? ' sel' : ''), title: `Seleccionar ${v.name}`, onclick: () => this.ed.select(v.id) },
        h('span', { class: 'dot', style: `background:${v.color}` }),
        h('strong', {}, v.label || '?'),
        h('span', { class: 'muted' }, v.drive ? ` ${Math.round(v.drive.speed)} km/h` : ' parado'),
      ),
      lane,
      speed,
    );
  }

  /** Marca arrastrable en el tiempo; clic derecho la quita. */
  private draggableTime(m: HTMLElement, lane: HTMLElement, commit: (t: number) => void, remove: () => void) {
    m.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      this.player.pause();
      try {
        m.setPointerCapture(e.pointerId);
      } catch {
        /* puntero ya liberado */
      }
      this.dragging = true;
      let t = this.timeAt(lane, e.clientX);
      let moved = false;
      const x0 = e.clientX;
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - x0) > 3) moved = true;
        t = Math.round(this.timeAt(lane, ev.clientX) * 20) / 20;
        m.style.left = `${this.pct(t)}%`;
        m.dataset.t = fmtT(t);
        this.player.setTime(t);
      };
      const up = () => {
        m.removeEventListener('pointermove', move);
        m.removeEventListener('pointerup', up);
        this.dragging = false;
        if (moved) commit(t);
        else this.player.setTime(t);
      };
      m.addEventListener('pointermove', move);
      m.addEventListener('pointerup', up);
    });
    m.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      remove();
    });
  }

  private closeMenu() {
    this.menu?.remove();
    this.menu = null;
  }

  /** Menú para añadir una acción del conductor en el instante t de la pista. */
  private openMenu(v: VehicleEntity, t: number, e: MouseEvent) {
    this.closeMenu();
    t = Math.round(t * 20) / 20;
    const menu = h('div', { class: 'tl-menu' }, h('div', { class: 'tl-menu-t' }, `${v.label} en ${fmtT(t)}`));
    const item = (label: string, fn: () => void) => menu.append(h('button', { onclick: () => (this.closeMenu(), fn()) }, label));
    if (!v.drive) item('Darle movimiento (ruta por su carril)', () => giveMotion(this.ed, v));
    else
      for (const [label, action, value] of ADD_MENU)
        item(label, () => {
          this.ed.store.edit(() => v.drive!.events.push({ id: newId('ev'), t, action, value }), { type: 'env' });
          toast(`${v.label}: ${ACTION_UI[action].name(value).toLowerCase()} en ${fmtT(t)}.`);
        });
    item('Colocar el vehículo en este instante…', () => {
      this.player.setTime(t);
      this.ed.select(v.id);
      toast(`Arrastra ${v.label} en la escena hasta donde estaba en ${fmtT(t)}; con la flecha giratoria orientas su rumbo.`, 'info', 6000);
    });
    const r = this.el.getBoundingClientRect();
    menu.style.left = `${Math.min(r.width - 230, Math.max(4, e.clientX - r.left))}px`;
    menu.style.bottom = `${r.bottom - e.clientY + 8}px`;
    this.el.append(menu);
    this.menu = menu;
  }

  private sync() {
    const t = this.player.time;
    this.label.textContent = `t = ${fmtT(t)}`;
    this.label.classList.toggle('after', t >= 0);
    for (const hd of this.heads) hd.style.left = `${this.pct(t)}%`;
    // cambiar el icono solo si cambia el estado: reemplazarlo bajo el puntero anula el clic
    const icon = this.player.playing ? ICONS.pause : ICONS.play;
    if (this.playBtn.dataset.icon !== icon) {
      this.playBtn.innerHTML = icon;
      this.playBtn.dataset.icon = icon;
    }
    // velocidades instantáneas
    const parts: string[] = [];
    for (const e of this.ed.store.project.entities) {
      if (e.kind !== 'vehicle' || !this.ed.world.sim?.vehicles.has(e.id)) continue;
      const p = this.ed.world.vehiclePose(e);
      const cell = this.grid.querySelector(`.tl-end.v[data-veh="${e.id}"]`);
      if (cell) cell.textContent = `${Math.round(p.v * 3.6)} km/h`;
      if (!this.ed.world.isDriven(e) && p.v < 0.05) continue;
      parts.push(`${e.label}: ${Math.round(p.v * 3.6)} km/h`);
    }
    this.speedInfo.textContent = this.folded ? parts.join(' · ') : '';
  }

  /** Resumen de contactos de la simulación (qué choca con qué y cuándo). */
  private checkOverlaps() {
    clear(this.warn);
    const sim = this.ed.world.sim;
    if (!sim) return;
    const name = (id: string) => {
      const e = this.ed.store.get(id);
      return e && e.kind === 'vehicle' ? e.label || e.name : id;
    };
    // agrupar contactos del mismo par (p. ej. dos tramos seguidos de una bionda)
    const groups: typeof sim.contacts = [];
    for (const c of sim.contacts.filter((c) => c.peakForce > 2000)) {
      const g = groups.find((x) => x.a === c.a && x.bName === c.bName && Math.abs(x.t0 - c.t0) < 0.3);
      if (!g) groups.push({ ...c });
      else if (c.peakForce > g.peakForce) Object.assign(g, { ...c, t0: Math.min(g.t0, c.t0) });
    }
    for (const c of groups.slice(0, 2))
      this.warn.append(
        h(
          'button',
          {
            class: 'tl-contact',
            title: `${name(c.a)} — ${c.bName} en ${fmtT(c.t0)} · Δv ${Math.round(c.dvA * 3.6)}${this.ed.store.get(c.b)?.kind === 'vehicle' ? ` / ${Math.round(c.dvB * 3.6)}` : ''} km/h · clic para ir a ese instante`,
            onclick: () => (this.player.pause(), this.player.setTime(c.t0)),
          },
          `💥 ${name(c.a)}–${this.ed.store.get(c.b)?.kind === 'vehicle' ? name(c.b) : c.bName.split(' ')[0]} ${fmtT(c.t0)}`,
        ),
      );
  }

  /** Graba la animación completa a tiempo real en WebM. */
  private record() {
    if (this.recorder) {
      this.recorder.stop();
      return;
    }
    const canvas = this.ed.vp.renderer.domElement;
    const stream = canvas.captureStream(30);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return toast('Este navegador no permite grabar vídeo del lienzo.', 'error');
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      this.recorder = null;
      this.el.classList.remove('recording');
      this.player.onEnd = null;
      const safe = this.ed.store.project.name.replace(/[^\w\-áéíóúñÁÉÍÓÚÑ ]+/g, '').trim() || 'reconstruccion';
      download(`${safe}.webm`, new Blob(chunks, { type: 'video/webm' }));
      toast('Vídeo grabado.');
    };
    this.recorder = rec;
    this.ed.select(null); // sin tiradores ni gizmos en el vídeo
    this.el.classList.add('recording');
    this.player.pause();
    this.player.setTime(this.player.range().start);
    this.player.onEnd = () => setTimeout(() => rec.state === 'recording' && rec.stop(), 300);
    rec.start(250);
    this.player.play();
    toast('Grabando… (pulsa de nuevo el botón rojo para detener)');
  }
}
