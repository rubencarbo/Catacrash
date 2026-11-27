import * as THREE from 'three';
import { analyze, type Analysis, type VehAnalysis } from '../analysis/analyze';
import type { Editor } from '../editor';
import type { VehicleEntity } from '../model/types';
import { frameAt } from '../physics/sim';
import { clear, h, toast } from './dom';

const ts = (t: number) => (Math.abs(t) < 0.005 ? '0,00 s' : `${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(2).replace('.', ',')} s`);

/** Imagen en planta (norte arriba) de la escena en el instante t, con rótulos, trayectorias, escala y norte. */
function planSnapshot(ed: Editor, t: number, box: { cx: number; cz: number; w: number; d: number }, caption: string): string {
  const { vp, world } = ed;
  const r = vp.renderer;
  const gl = r.domElement;
  const W = gl.width;
  const H = gl.height;
  const pr = r.getPixelRatio();
  // encuadre con la proporción de la zona (norte arriba): ancho = este-oeste, alto = norte-sur
  const aspect = Math.min(1.8, Math.max(0.8, box.w / box.d));
  let rw = W;
  let rh = Math.round(W / aspect);
  if (rh > H) {
    rh = H;
    rw = Math.round(H * aspect);
  }
  const cam = new THREE.PerspectiveCamera(30, aspect, 1, 5000);
  const tanV = Math.tan((15 * Math.PI) / 180);
  const need = Math.max(box.d / 2 / tanV, box.w / 2 / (tanV * aspect));
  const gy = world.surfaceHeight(box.cx, box.cz);
  cam.position.set(box.cx, gy + need, box.cz);
  cam.up.set(0, 0, -1);
  cam.lookAt(box.cx, gy, box.cz);
  cam.updateMatrixWorld();
  const prev = world.time;
  world.setTime(t);
  r.setScissorTest(true);
  r.setScissor(0, (H - rh) / pr, rw / pr, rh / pr);
  r.setViewport(0, (H - rh) / pr, rw / pr, rh / pr);
  r.render(vp.scene, cam);
  r.setScissorTest(false);
  r.setViewport(0, 0, W / pr, H / pr);
  const c = document.createElement('canvas');
  const k = Math.min(1, 900 / rw);
  c.width = Math.round(rw * k);
  c.height = Math.round(rh * k);
  const g = c.getContext('2d')!;
  g.drawImage(gl, 0, 0, rw, rh, 0, 0, c.width, c.height);
  // tamaño de rótulos pensado para verse a un tercio del ancho del informe
  const fs = c.width / 330;
  const proj = (x: number, z: number) => {
    const v = new THREE.Vector3(x, world.surfaceHeight(x, z), z).project(cam);
    return [((v.x + 1) / 2) * c.width, ((1 - v.y) / 2) * c.height] as const;
  };
  // trayectorias (centro) y rótulos
  const sim = world.sim;
  const anchors: { px: number; py: number; label: string; v: number }[] = [];
  for (const e of world.store.project.entities) {
    if (e.kind !== 'vehicle' || !sim?.vehicles.has(e.id)) continue;
    const sv = sim.vehicles.get(e.id)!;
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 3.5 * fs;
    g.setLineDash([]);
    const path = () => {
      g.beginPath();
      sv.frames.forEach((f, i) => {
        if (i % 3) return;
        const [px, py] = proj(f.x, f.z);
        if (i === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      });
    };
    path();
    g.stroke();
    g.strokeStyle = (e as VehicleEntity).color;
    g.lineWidth = 2 * fs;
    g.setLineDash([6 * fs, 4 * fs]);
    path();
    g.stroke();
    g.setLineDash([]);
    const f = frameAt(sv, t);
    const [px, py] = proj(f.x, f.z);
    anchors.push({ px, py, label: (e as VehicleEntity).label || '?', v: f.v });
  }
  // rótulos sin solaparse: si chocan con uno ya puesto, se apartan con una línea de referencia
  const placed: [number, number][] = [];
  const offs = [
    [0, -34],
    [-46, -22],
    [46, -22],
    [-46, 26],
    [46, 26],
    [0, 40],
  ];
  for (const an of anchors) {
    let lx = an.px;
    let ly = an.py - 34 * fs;
    for (const [ox, oy] of offs) {
      const cx = an.px + ox * fs;
      const cy = an.py + oy * fs;
      if (placed.every(([qx, qy]) => Math.hypot(qx - cx, qy - cy) > 44 * fs)) {
        lx = cx;
        ly = cy;
        break;
      }
    }
    placed.push([lx, ly]);
    g.strokeStyle = '#fff';
    g.lineWidth = 1.5 * fs;
    g.beginPath();
    g.moveTo(an.px, an.py);
    g.lineTo(lx, ly);
    g.stroke();
    g.fillStyle = '#111';
    g.beginPath();
    g.arc(lx, ly, 12 * fs, 0, Math.PI * 2);
    g.fill();
    g.lineWidth = 2 * fs;
    g.stroke();
    g.fillStyle = '#fff';
    g.font = `bold ${14 * fs}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(an.label, lx, ly);
    g.font = `${11 * fs}px system-ui, sans-serif`;
    g.strokeStyle = 'rgba(0,0,0,0.75)';
    g.lineWidth = 3 * fs;
    const txt = `${Math.round(an.v * 3.6)} km/h`;
    g.strokeText(txt, lx, ly - 19 * fs);
    g.fillText(txt, lx, ly - 19 * fs);
  }
  // escala (10 m)
  const [ax] = proj(box.cx, box.cz);
  const [bx] = proj(box.cx + 10, box.cz);
  const px10 = Math.abs(bx - ax);
  const sx = 10 * fs;
  const sy = c.height - 10 * fs;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(sx - 5 * fs, sy - 18 * fs, px10 + 46 * fs, 26 * fs);
  g.strokeStyle = '#fff';
  g.lineWidth = 2 * fs;
  g.beginPath();
  g.moveTo(sx, sy - 4 * fs);
  g.lineTo(sx, sy);
  g.lineTo(sx + px10, sy);
  g.lineTo(sx + px10, sy - 4 * fs);
  g.stroke();
  g.fillStyle = '#fff';
  g.font = `${11 * fs}px system-ui, sans-serif`;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillText('10 m', sx + px10 + 5 * fs, sy);
  // norte
  const nx = c.width - 18 * fs;
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(nx - 12 * fs, 8 * fs, 24 * fs, 34 * fs);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.font = `bold ${11 * fs}px system-ui, sans-serif`;
  g.fillText('N', nx, 21 * fs);
  g.beginPath();
  g.moveTo(nx, 25 * fs);
  g.lineTo(nx - 6 * fs, 38 * fs);
  g.lineTo(nx + 6 * fs, 38 * fs);
  g.closePath();
  g.fill();
  void caption;
  const url = c.toDataURL('image/jpeg', 0.86);
  world.setTime(prev);
  vp.renderer.render(vp.scene, vp.camera);
  return url;
}

/** Gráfica velocidad–tiempo de los vehículos (SVG con cursor y valores al pasar el ratón). */
function speedChart(ed: Editor, an: Analysis): HTMLElement {
  const sim = ed.world.sim!;
  const vs = an.vehicles;
  const W = 720;
  const H = 240;
  const m = { l: 44, r: 16, t: 14, b: 30 };
  const t0 = sim.start;
  const t1 = Math.min(sim.end, Math.max(1, ...vs.map((v) => (v.rest?.t ?? sim.end) + 0.5)));
  const vmax = Math.max(20, ...vs.map((v) => Math.max(...sim.vehicles.get(v.id)!.frames.map((f) => f.v * 3.6))));
  const vTop = Math.ceil(vmax / 20) * 20;
  const X = (t: number) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const Y = (v: number) => m.t + (1 - v / vTop) * (H - m.t - m.b);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'speed-chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Velocidad de cada vehículo en función del tiempo');
  const add = (tag: string, attrs: Record<string, string | number>, text?: string) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    svg.appendChild(n);
    return n;
  };
  // rejilla y ejes (recesivos)
  for (let v = 0; v <= vTop; v += 20) {
    add('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'grid' });
    add('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'tick' }, String(v));
  }
  const step = t1 - t0 > 10 ? 2 : 1;
  for (let t = Math.ceil(t0); t <= t1; t += step) add('text', { x: X(t), y: H - 10, 'text-anchor': 'middle', class: 'tick' }, `${t < 0 ? '−' : t > 0 ? '+' : ''}${Math.abs(t)} s`);
  add('text', { x: m.l, y: m.t - 2, class: 'tick' }, 'km/h');
  // impacto
  add('line', { x1: X(0), x2: X(0), y1: m.t, y2: H - m.b, class: 'zero' });
  add('text', { x: X(0) + 4, y: m.t + 10, class: 'tick' }, 'impacto');
  // series
  for (const v of vs) {
    const F = sim.vehicles.get(v.id)!.frames.filter((f) => f.t <= t1);
    const d = F.filter((_, i) => i % 2 === 0)
      .map((f, i) => `${i ? 'L' : 'M'}${X(f.t).toFixed(1)},${Y(f.v * 3.6).toFixed(1)}`)
      .join('');
    add('path', { d, fill: 'none', stroke: v.color, 'stroke-width': 2, 'stroke-linejoin': 'round' });
    // rótulo directo al principio de la serie (donde las velocidades se distinguen)
    add('text', { x: m.l + 6, y: Y(F[0].v * 3.6) - 7, class: 'lbl' }, v.label);
    // límite de velocidad
    if (v.limit) add('line', { x1: m.l, x2: W - m.r, y1: Y(v.limit.value), y2: Y(v.limit.value), class: 'limit' });
  }
  // capa de cursor
  const cross = add('line', { x1: 0, x2: 0, y1: m.t, y2: H - m.b, class: 'cross', visibility: 'hidden' });
  const dots = vs.map((v) => add('circle', { r: 4, fill: v.color, stroke: 'var(--panel)', 'stroke-width': 2, visibility: 'hidden' }));
  const tip = h('div', { class: 'chart-tip' });
  const hit = add('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' });
  const wrap = h('div', { class: 'chart-wrap' });
  hit.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const sx = ((ev as PointerEvent).clientX - r.left) * (W / r.width);
    const t = t0 + ((sx - m.l) / (W - m.l - m.r)) * (t1 - t0);
    cross.setAttribute('x1', String(X(t)));
    cross.setAttribute('x2', String(X(t)));
    cross.setAttribute('visibility', 'visible');
    const rows = vs.map((v, i) => {
      const f = frameAt(sim.vehicles.get(v.id)!, t);
      dots[i].setAttribute('cx', String(X(t)));
      dots[i].setAttribute('cy', String(Y(f.v * 3.6)));
      dots[i].setAttribute('visibility', 'visible');
      return `<div><span class="sw" style="background:${v.color}"></span>${v.label}: <b>${Math.round(f.v * 3.6)} km/h</b></div>`;
    });
    tip.innerHTML = `<div class="muted">${ts(t)}</div>${rows.join('')}`;
    tip.style.display = 'block';
    const left = ((ev as PointerEvent).clientX - r.left) / r.width;
    tip.style.left = left > 0.7 ? '' : `${left * 100 + 2}%`;
    tip.style.right = left > 0.7 ? `${(1 - left) * 100 + 2}%` : '';
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
    tip.style.display = 'none';
  });
  const legend = h(
    'div',
    { class: 'chart-legend' },
    ...vs.map((v) => h('span', {}, h('span', { class: 'sw', style: `background:${v.color}` }), `${v.label} · ${v.name}`)),
    vs.some((v) => v.limit) ? h('span', {}, h('span', { class: 'sw dash' }), 'Límite de velocidad') : null,
  );
  wrap.append(svg, tip);
  return h('div', {}, legend, wrap);
}

export function openReport(ed: Editor) {
  if (!ed.world.sim) return toast('No hay simulación: dale movimiento a algún vehículo primero.', 'error');
  ed.player?.pause();
  const ov: HTMLDivElement = h('div', { class: 'help-overlay report-overlay', onclick: (e: Event) => e.target === ov && ov.remove() });
  const card = h('div', { class: 'help-card report-card' });
  ov.append(card);
  document.body.append(ov);
  card.append(h('p', { class: 'muted' }, 'Analizando la reconstrucción y simulando alternativas…'));
  // dejar que se pinte el aviso antes del cálculo
  setTimeout(() => render(), 30);

  const render = () => {
    const an = analyze(ed.world);
    clear(card);
    const p = ed.store.project;
    const head = h(
      'div',
      { class: 'report-head' },
      h('div', {}, h('h2', {}, 'Informe del accidente'), h('div', { class: 'muted' }, `${p.name} · generado el ${new Date().toLocaleDateString('es-ES')} con Catacrash`)),
      h(
        'div',
        { class: 'row no-print', style: 'gap:8px' },
        h('button', { class: 'btn', onclick: () => window.print() }, 'Imprimir / PDF'),
        h('button', { class: 'btn', onclick: () => ov.remove() }, 'Cerrar'),
      ),
    );
    card.append(head);
    if (!an.ok) {
      card.append(h('p', { class: 'warn' }, an.message ?? 'No se puede analizar.'));
      return;
    }
    const sec = (title: string, ...kids: (Node | string | null)[]) => h('section', { class: 'report-sec' }, h('h3', {}, title), ...kids);

    // Resumen
    card.append(sec('Conclusión', h('ul', { class: 'report-list' }, ...an.conclusion.map((c) => h('li', {}, c))), h('p', { class: 'muted' }, an.conditions.join(' '))));

    // Vehículos
    const vt = h('table', { class: 'fit-table report-table' });
    const row = (k: string, f: (a: VehAnalysis) => string) => vt.append(h('tr', {}, h('th', {}, k), ...an.vehicles.map((a) => h('td', {}, f(a)))));
    vt.append(h('tr', {}, h('th', {}, ''), ...an.vehicles.map((a) => h('th', {}, h('span', { class: 'dot', style: `background:${a.color}` }), `${a.label} · ${a.name}`))));
    const veh = (id: string) => ed.store.get(id) as VehicleEntity;
    row('Masa', (a) => `${Math.round(veh(a.id).spec.masa)} kg`);
    row('Velocidad inicial', (a) => `${a.v0} km/h`);
    row('Límite', (a) => (a.limit ? `${a.limit.value} km/h${a.excess !== null && a.excess > 5 ? ` (+${a.excess})` : ''}` : 'no consta'));
    row('Primera reacción', (a) => (a.action ? `${a.action.text} (${ts(a.action.t)})` : 'ninguna'));
    row('Tiempo de reacción', (a) => (a.reaction !== null ? `${a.reaction.toFixed(1).replace('.', ',')} s` : '—'));
    row('Velocidad en el impacto', (a) => (a.vImpact !== null ? `${a.vImpact} km/h` : '—'));
    row('Δv', (a) => (a.dv !== null ? `${a.dv} km/h` : '—'));
    row('Invasión del carril contrario', (a) => (a.invasion ? `${a.invasion.max.toFixed(1).replace('.', ',')} m` : 'no'));
    row('Huella más larga', (a) => (a.skid > 0.5 ? `${a.skid.toFixed(1).replace('.', ',')} m` : '—'));
    row('Reposo', (a) => (a.rest?.t != null ? `${ts(a.rest.t)}${a.rest.distFromImpact !== null ? ` · a ${a.rest.distFromImpact.toFixed(1).replace('.', ',')} m` : ''}` : 'en movimiento al final'));
    card.append(sec('Vehículos', vt));

    // Imágenes en planta
    const sim = ed.world.sim!;
    const tc = sim.firstContact ?? 0;
    const restT = Math.min(sim.end, Math.max(tc + 0.5, ...an.vehicles.map((a) => a.rest?.t ?? sim.end)));
    const tBefore = Math.max(sim.start, Math.min(tc - 1.5, ...an.vehicles.map((a) => (a.action ? a.action.t - 0.3 : tc - 1.5))));
    const pts: { x: number; z: number }[] = [];
    for (const a of an.vehicles) {
      const sv = sim.vehicles.get(a.id)!;
      for (const t of [tBefore, tc, restT]) pts.push(frameAt(sv, t));
    }
    const xs = pts.map((q) => q.x);
    const zs = pts.map((q) => q.z);
    const box = {
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cz: (Math.min(...zs) + Math.max(...zs)) / 2,
      w: Math.max(24, (Math.max(...xs) - Math.min(...xs)) * 1.15 + 14),
      d: Math.max(24, (Math.max(...zs) - Math.min(...zs)) * 1.15 + 14),
    };
    const imgs = h('div', { class: 'report-imgs' });
    for (const [t, cap] of [
      [tBefore, `Antes (${ts(tBefore)})`],
      [tc, `Impacto (${ts(tc)})`],
      [restT, `Posiciones finales (${ts(restT)})`],
    ] as [number, string][]) {
      try {
        imgs.append(h('figure', {}, h('img', { src: planSnapshot(ed, t, box, cap), alt: cap }), h('figcaption', {}, cap)));
      } catch {
        /* sin imagen si el lienzo no se puede leer */
      }
    }
    card.append(sec('Vista en planta', imgs));

    card.append(sec('Velocidades', speedChart(ed, an)));
    card.append(sec('Desarrollo', ...an.narrative.map((t) => h('p', {}, t))));

    // Cronología
    const ct = h('table', { class: 'fit-table report-table chrono' });
    ct.append(h('tr', {}, h('th', {}, 'Instante'), h('th', {}, 'Suceso'), h('th', { class: 'no-print' }, '')));
    for (const ev of an.events) {
      const a = an.vehicles.find((v) => v.id === ev.veh);
      ct.append(
        h(
          'tr',
          { class: `ev-${ev.kind}` },
          h('td', {}, ts(ev.t)),
          h('td', {}, a ? h('span', { class: 'dot', style: `background:${a.color}` }) : null, ev.text),
          h('td', { class: 'no-print' }, h('button', { class: 'btn small', title: 'Ver ese instante en la escena', onclick: () => (ov.remove(), ed.player?.setTime(ev.t)) }, 'Ver')),
        ),
      );
    }
    card.append(sec('Cronología', ct));

    // Factores
    const lv = { alto: 'Determinante', medio: 'Contribuyente', bajo: 'Menor', info: 'Dato' } as const;
    card.append(
      sec(
        'Factores',
        an.factors.length
          ? h('ul', { class: 'report-factors' }, ...an.factors.map((f) => h('li', { class: `lv-${f.level}` }, h('span', { class: 'lv' }, lv[f.level]), f.text)))
          : h('p', { class: 'muted' }, 'Sin factores destacables.'),
      ),
    );

    // Evitabilidad
    card.append(
      sec(
        '¿Se podía haber evitado?',
        an.alternatives.length
          ? h(
              'ul',
              { class: 'report-alts' },
              ...an.alternatives.map((x) => h('li', { class: x.avoided ? 'yes' : 'no' }, h('span', { class: 'mark' }, x.avoided ? '✔ Se evita' : '✘ No se evita'), h('strong', {}, `${x.title}. `), x.text)),
            )
          : h('p', { class: 'muted' }, an.pair ? 'No se han planteado alternativas (sin exceso de velocidad, invasión ni reacción tardía).' : 'Sin choque entre vehículos que analizar.'),
        h(
          'p',
          { class: 'muted' },
          'Cada alternativa vuelve a simular el accidente desde las mismas posiciones iniciales cambiando solo una conducta; el resto de maniobras se mantienen en los mismos instantes.',
        ),
      ),
    );
    card.append(
      h(
        'p',
        { class: 'muted report-foot' },
        'Reconstrucción orientativa basada en una simulación física simplificada y en los datos introducidos (croquis, fotos, medidas). No es un informe pericial: sus valores dependen de esos datos y de hipótesis como el tiempo de reacción de referencia (1 s) o la adherencia del firme.',
      ),
    );
  };
}
