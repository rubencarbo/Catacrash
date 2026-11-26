import type { CameraMode, Player } from '../anim/player';
import type { Editor } from '../editor';
import { download } from '../io/file';
import type { VehicleEntity } from '../model/types';
import { clear, fmt, h, toast } from './dom';
import { findOverlaps } from '../anim/overlap';

const ICONS = {
  play: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 4h4v16H6zM14 4h4v16h-4z" fill="currentColor"/></svg>',
  start: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 4h2v16H6zM20 4L9 12l11 8z" fill="currentColor"/></svg>',
  end: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M16 4h2v16h-2zM4 4l11 8-11 8z" fill="currentColor"/></svg>',
  rec: '<svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>',
};

const fmtT = (t: number) => `${t < 0 ? '−' : t > 0 ? '+' : ''}${fmt(Math.abs(t), 2)} s`;

/** Barra de animación en la parte inferior del visor. */
export class TimelineBar {
  el: HTMLElement;
  private slider: HTMLInputElement;
  private label: HTMLElement;
  private playBtn: HTMLButtonElement;
  private marks: HTMLElement;
  private speedInfo: HTMLElement;
  private recorder: MediaRecorder | null = null;
  private warn: HTMLElement;
  private warnTimer = 0;

  constructor(
    host: HTMLElement,
    private ed: Editor,
    private player: Player,
  ) {
    this.el = h('div', { class: 'timeline' });
    this.playBtn = h('button', { class: 'tl-btn play', title: 'Reproducir / pausa (Espacio)', html: ICONS.play, onclick: () => player.toggle() });
    this.slider = h('input', {
      type: 'range',
      step: 0.01,
      oninput: () => player.setTime(Number(this.slider.value)),
      onpointerdown: () => player.pause(),
    });
    this.label = h('span', { class: 'tl-time' }, '');
    this.marks = h('div', { class: 'tl-marks' });
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
    const startIn = h('input', { type: 'number', class: 'tl-range', step: 0.5, value: range.start, title: 'Inicio (s)', onchange: () => this.setRange() });
    const endIn = h('input', { type: 'number', class: 'tl-range', step: 0.5, value: range.end, title: 'Fin (s)', onchange: () => this.setRange() });
    (this as unknown as { startIn: HTMLInputElement }).startIn = startIn;
    (this as unknown as { endIn: HTMLInputElement }).endIn = endIn;

    this.el.append(
      h('button', { class: 'tl-btn', title: 'Ir al inicio', html: ICONS.start, onclick: () => (player.pause(), player.setTime(player.range().start)) }),
      this.playBtn,
      h('button', { class: 'tl-btn', title: 'Ir al final', html: ICONS.end, onclick: () => (player.pause(), player.setTime(player.range().end)) }),
      h('button', { class: 'tl-btn impact', title: 'Ir al instante del impacto (t = 0)', onclick: () => (player.pause(), player.setTime(0)) }, 'Impacto'),
      this.label,
      startIn,
      h('div', { class: 'tl-track' }, this.marks, this.slider),
      endIn,
      rate,
      cam,
      h('button', { class: 'tl-btn rec', title: 'Grabar vídeo de toda la animación (WebM)', html: ICONS.rec, onclick: () => this.record() }),
      this.speedInfo,
      this.warn,
    );
    host.append(this.el);
    player.on(() => this.sync());
    ed.store.on(() => {
      this.syncMarks();
      clearTimeout(this.warnTimer);
      this.warnTimer = window.setTimeout(() => this.checkOverlaps(), 400);
    });
    setTimeout(() => this.checkOverlaps(), 500);
    ed.store.onSelect(() => this.syncMarks());
    window.addEventListener('keydown', (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        player.toggle();
      }
    });
    this.syncMarks();
    this.sync();
  }

  private setRange() {
    const s = Number((this as unknown as { startIn: HTMLInputElement }).startIn.value);
    const e = Number((this as unknown as { endIn: HTMLInputElement }).endIn.value);
    if (!(e > s)) return toast('El final debe ser posterior al inicio.', 'error');
    this.ed.store.edit(() => (this.ed.store.project.timeline = { start: Math.min(s, 0), end: Math.max(e, 0) }), { type: 'env' });
    this.syncMarks();
    this.sync();
  }

  private sync() {
    const { start, end } = this.player.range();
    this.slider.min = String(start);
    this.slider.max = String(end);
    this.slider.value = String(this.player.time);
    this.label.textContent = `t = ${fmtT(this.player.time)}`;
    this.label.classList.toggle('after', this.player.time >= 0);
    this.playBtn.innerHTML = this.player.playing ? ICONS.pause : ICONS.play;
    // Velocidades instantáneas de los vehículos animados
    const parts: string[] = [];
    for (const e of this.ed.store.project.entities) {
      if (e.kind !== 'vehicle' || (e.motion?.length ?? 0) < 2) continue;
      const p = this.ed.world.vehiclePose(e);
      parts.push(`${e.label}: ${Math.round(p.speed * 3.6)} km/h`);
    }
    this.speedInfo.textContent = parts.join(' · ');
  }

  /** Marcas en la pista: claves de cada vehículo (resaltadas las del seleccionado) e impacto. */
  private syncMarks() {
    clear(this.marks);
    const { start, end } = this.player.range();
    const pct = (t: number) => `${((t - start) / (end - start)) * 100}%`;
    const startIn = (this as unknown as { startIn?: HTMLInputElement }).startIn;
    const endIn = (this as unknown as { endIn?: HTMLInputElement }).endIn;
    if (startIn && document.activeElement !== startIn) startIn.value = String(start);
    if (endIn && document.activeElement !== endIn) endIn.value = String(end);
    if (0 >= start && 0 <= end) this.marks.append(h('span', { class: 'tl-impact', style: `left:${pct(0)}`, title: 'Impacto' }));
    const sel = this.ed.store.selection?.id;
    for (const e of this.ed.store.project.entities) {
      if (e.kind !== 'vehicle' || !e.motion?.length) continue;
      const v = e as VehicleEntity;
      for (const k of v.motion!)
        this.marks.append(
          h('span', {
            class: 'tl-key' + (v.id === sel ? ' sel' : ''),
            style: `left:${pct(k.t)};background:${v.color}`,
            title: `${v.label} · ${fmtT(k.t)}`,
          }),
        );
    }
    this.sync();
  }

  /** Avisa si algún par de vehículos se atraviesa durante la animación. */
  private checkOverlaps() {
    const vs = this.ed.store.project.entities.filter((e): e is VehicleEntity => e.kind === 'vehicle' && !e.hidden);
    const { start, end } = this.player.range();
    const list = findOverlaps(this.ed.world, vs, start, end);
    clear(this.warn);
    for (const o of list.slice(0, 3))
      this.warn.append(
        h(
          'button',
          {
            class: 'tl-warn-item',
            title: 'Ir a ese instante',
            onclick: () => (this.player.pause(), this.player.setTime(o.from)),
          },
          `⚠ ${o.a} y ${o.b} se atraviesan entre ${fmtT(o.from)} y ${fmtT(o.to)} (hasta ${fmt(o.max, 1)} m)`,
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
