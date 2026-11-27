import type { Editor } from '../editor';
import type { VehicleEntity } from '../model/types';
import { soloSpeedAt } from '../physics/sim';
import { applyParams, candidateParams, evaluate, fit, usesImpactSpeed, type FitParam, type FitProblem, type FitResult, type FitTarget, type TargetError } from '../physics/fit';
import { clear, fmt, h, toast } from './dom';
import { applyAllMarks } from '../physics/marks';

interface ParamRow {
  p: FitParam;
  on: boolean;
}

const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

const fmtVal = (p: FitParam, v: number) => (p.unit === '×' ? `${Math.round(v * 100)} %` : p.unit === 's' ? `${v < 0 ? '−' : '+'}${fmt(Math.abs(v), 2)} s` : `${fmt(v, p.unit === 'km/h' ? 0 : 1)} ${p.unit}`);

/**
 * «Ajustar a los hechos»: el usuario indica lo observado (posición final del croquis, daños medidos
 * en las fotos, huella de frenada) y qué valores desconoce; la app busca los que hacen que la
 * simulación lo reproduzca y propone aplicarlos.
 */
export function openFitDialog(ed: Editor, focusId?: string, opts: { autoRun?: boolean } = {}) {
  const store = ed.store;
  const p = store.project;
  const range = p.timeline ?? { start: -4, end: 4 };
  const driven = p.entities.filter((e): e is VehicleEntity => e.kind === 'vehicle' && !!e.drive && e.drive.path.length >= 2 && !e.hidden);
  if (!driven.length) return toast('Primero dale movimiento a algún vehículo (inspector del vehículo → «Darle movimiento»).', 'error');

  const lastFrame = (id: string) => {
    const sv = ed.world.sim?.vehicles.get(id);
    return sv ? sv.frames[sv.frames.length - 1] : null;
  };
  const maxCrush = (v: VehicleEntity) => (v.damage.length ? Math.max(...v.damage.map((z) => z.depth)) : 0);
  // vehículos con algo observado: los que circulan y los parados con posiciones observadas tras el golpe
  const observed = p.entities.filter((e): e is VehicleEntity => e.kind === 'vehicle' && !e.hidden && (driven.includes(e) || !!e.pins?.length));

  // ---- estado del formulario ----
  const obs = new Map(
    observed.map((v) => [
      v.id,
      {
        final: !!v.drive?.showFinal,
        crush: maxCrush(v) > 0,
        skid: v.drive?.skidObs ?? null,
        pins: !!v.pins?.length,
      },
    ]),
  );
  const fmtPinT = (t: number) => `t = ${t < 0 ? '−' : '+'}${Math.abs(t).toFixed(2).replace('.', ',')} s`;
  const isBrakeT = (v: VehicleEntity, prm: FitParam) => prm.kind === 'evT' && v.drive!.events.find((e) => e.id === prm.event)?.action === 'frenar';
  // velocidad que llevaría en t = 0 con su conducción actual (sin choques previos que la alteren)
  const baseInput = ed.world.simInput();
  const impactKmh = (v: VehicleEntity) => (usesImpactSpeed(v) ? Math.round(soloSpeedAt(v, baseInput, 0) * 36) / 10 : null);
  const rows: ParamRow[] = driven.flatMap((v) =>
    candidateParams(v, range.start, impactKmh(v)).map((prm) => ({
      p: prm,
      // la posición final no dice cuándo se frenó: ese instante solo es incógnita si hay huella medida
      on: prm.kind === 'speed' || prm.kind === 'impact' || (isBrakeT(v, prm) && v.drive!.skidObs != null),
    })),
  );

  let running = false;
  let cancel = false;
  let result: { r: FitResult; params: FitParam[]; pb: FitProblem } | null = null;

  const ov: HTMLDivElement = h('div', { class: 'help-overlay', onclick: (e: Event) => e.target === ov && !running && close() });
  const card = h('div', { class: 'help-card fit-card' });
  ov.append(card);
  const close = () => {
    cancel = true;
    ed.vp.paused = false;
    ov.remove();
  };

  const body = h('div');
  const progress = h('div', { class: 'fit-progress' });
  const resultsEl = h('div');
  const runBtn = h('button', { class: 'btn primary', onclick: () => run() }, 'Buscar');
  const closeBtn = h('button', { class: 'btn', onclick: () => (running ? (cancel = true) : close()) }, 'Cerrar');
  card.append(
    h('h2', {}, 'Ajustar a los hechos'),
    h(
      'p',
      { class: 'muted' },
      'La app prueba cientos de variantes de la simulación y busca las velocidades y maniobras con las que el resultado coincide con lo observado. Marca lo que sabes (izquierda) y lo que quieres averiguar (incógnitas).',
    ),
    body,
    progress,
    resultsEl,
    h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:14px;gap:8px' }, closeBtn, runBtn),
  );

  const num = (value: number | null, onchange: (v: number | null) => void, attrs: Record<string, string | number> = {}) =>
    h('input', {
      type: 'number',
      class: 'fit-num',
      value: value === null ? '' : String(Math.round(value * 100) / 100),
      ...attrs,
      onchange: (e: Event) => {
        const t = (e.target as HTMLInputElement).value.trim();
        onchange(t === '' ? null : Number(t.replace(',', '.')));
      },
    });

  const renderForm = () => {
    clear(body);
    // Lo observado
    body.append(h('div', { class: 'cat-title' }, 'Lo observado'));
    for (const v of observed) {
      const o = obs.get(v.id)!;
      const lf = lastFrame(v.id);
      const isDriven = driven.includes(v);
      const pinsRow = v.pins?.length
        ? h(
            'label',
            { class: 'check' },
            h('input', { type: 'checkbox', checked: o.pins, onchange: (e: Event) => (o.pins = (e.target as HTMLInputElement).checked) }),
            `Posiciones observadas en ${v.pins.map((q) => fmtPinT(q.t)).join(', ')}`,
          )
        : null;
      if (!isDriven) {
        body.append(h('div', { class: 'fit-veh' + (v.id === focusId ? ' focus' : '') }, h('div', { class: 'fit-veh-title' }, h('span', { class: 'dot', style: `background:${v.color}` }), `${v.label} · parado`), pinsRow));
        continue;
      }
      const now = lf ? `ahora el reposo simulado queda a ${fmt(Math.hypot(lf.x - v.x, lf.z - v.z), 1)} m y ${Math.round(angDiff(lf.h, v.heading))}°` : '';
      const crush = maxCrush(v);
      body.append(
        h(
          'div',
          { class: 'fit-veh' + (v.id === focusId ? ' focus' : '') },
          h('div', { class: 'fit-veh-title' }, h('span', { class: 'dot', style: `background:${v.color}` }), `${v.label} · ${v.spec.marca ? `${v.spec.marca} ${v.spec.modelo}` : v.name}`),
          h(
            'label',
            { class: 'check' },
            h('input', { type: 'checkbox', checked: o.final, onchange: (e: Event) => (o.final = (e.target as HTMLInputElement).checked) }),
            'Posición final del croquis (contorno discontinuo)',
            now ? h('span', { class: 'muted' }, ` — ${now}`) : null,
          ),
          pinsRow,
          h(
            'label',
            { class: 'check' + (crush ? '' : ' disabled') },
            h('input', { type: 'checkbox', checked: o.crush, disabled: !crush, onchange: (e: Event) => (o.crush = (e.target as HTMLInputElement).checked) }),
            crush ? `Aplastamiento medido en las fotos: ${Math.round(crush * 100)} cm` : 'Aplastamiento medido (marca zonas de daño en el inspector para usarlo)',
          ),
          h(
            'label',
            { class: 'fit-inline' },
            'Huella de frenada antes del choque:',
            num(
              o.skid,
              (x) => {
                o.skid = x && x > 0 ? x : null;
                // con huella, el instante de la frenada pasa a poder averiguarse
                for (const r of rows) if (r.p.veh === v.id && isBrakeT(v, r.p)) r.on = o.skid !== null;
                renderForm();
              },
              { min: 0, step: 0.5, placeholder: '—' },
            ),
            'm',
          ),
        ),
      );
    }
    // Incógnitas
    body.append(h('div', { class: 'cat-title' }, 'Incógnitas (lo que la app debe averiguar)'));
    const table = h('table', { class: 'fit-table' });
    table.append(h('tr', {}, h('th', {}, ''), h('th', {}, 'Vehículo'), h('th', {}, 'Valor'), h('th', {}, 'Actual'), h('th', {}, 'Rango de búsqueda')));
    for (const r of rows) {
      const v = driven.find((d) => d.id === r.p.veh)!;
      table.append(
        h(
          'tr',
          { class: r.on ? '' : 'off' },
          h('td', {}, h('input', { type: 'checkbox', checked: r.on, onchange: (e: Event) => ((r.on = (e.target as HTMLInputElement).checked), renderForm()) })),
          h('td', {}, h('span', { class: 'dot', style: `background:${v.color}` }), v.label),
          h('td', {}, r.p.label),
          h('td', {}, fmtVal(r.p, r.p.value)),
          h('td', {}, num(r.p.min, (x) => x !== null && (r.p.min = x)), ' – ', num(r.p.max, (x) => x !== null && (r.p.max = x)), ` ${r.p.unit === '×' ? '' : r.p.unit}`),
        ),
      );
    }
    body.append(table);
    const synced = driven.filter((v) => v.drive!.sync);
    body.append(
      h(
        'p',
        { class: 'muted' },
        synced.length && p.impact
          ? `Con el punto de colisión fijado, ${synced.map((v) => v.label).join(' y ')} llega${synced.length > 1 ? 'n' : ''} siempre a él en t = 0: la búsqueda cambia cómo llegan, no dónde chocan.`
          : 'Sin punto de colisión fijado, cambiar velocidades cambia también dónde (y si) se encuentran los vehículos.',
        ' Para añadir maniobras como incógnita (un volantazo, una frenada), créalas antes en el inspector del vehículo.',
      ),
    );
  };

  const describeErr = (e: TargetError, label: string) => {
    const parts: string[] = [];
    if (e.dist !== null) parts.push(`posición final a ${fmt(e.dist, 1)} m y ${Math.round(e.dh ?? 0)}°`);
    if (e.crushSim !== null) parts.push(`aplastamiento ${Math.round(e.crushSim * 100)} cm (medido ${Math.round((e.crushObs ?? 0) * 100)})`);
    if (e.skidSim !== null) parts.push(`huella ${fmt(e.skidSim, 1)} m (medida ${fmt(e.skidObs ?? 0, 1)})`);
    for (const q of e.pins) parts.push(`en ${fmtPinT(q.t)} a ${fmt(q.dist, 1)} m y ${Math.round(q.dh)}°`);
    if (!e.contact) parts.push('no llega a chocar');
    if (e.dist !== null && e.moving > 0.3) parts.push(`aún se mueve a ${Math.round(e.moving * 3.6)} km/h`);
    return `${label}: ${parts.join(' · ') || 'sin datos que comparar'}`;
  };
  const good = (errs: TargetError[]) =>
    errs.every((e) => (e.dist === null || (e.dist < 1.5 && (e.dh ?? 0) < 15)) && (e.crushSim === null || Math.abs(e.crushSim - (e.crushObs ?? 0)) < 0.2) && (e.skidSim === null || Math.abs(e.skidSim - (e.skidObs ?? 0)) < 2.5) && e.pins.every((q) => q.dist < 1.5 && q.dh < 15) && e.contact);

  const run = async () => {
    const params = rows.filter((r) => r.on).map((r) => r.p);
    if (!params.length) return toast('Marca al menos una incógnita.', 'error');
    if (params.some((q) => !(q.max > q.min))) return toast('Revisa los límites: el máximo debe ser mayor que el mínimo.', 'error');
    const targets: FitTarget[] = observed.map((v) => {
      const o = obs.get(v.id)!;
      const isDriven = driven.includes(v);
      return {
        veh: v.id,
        final: isDriven && o.final ? { x: v.x, z: v.z, h: v.heading } : null,
        crush: o.crush && maxCrush(v) > 0 ? maxCrush(v) : null,
        skid: isDriven ? o.skid : null,
        pins: o.pins ? (v.pins ?? []) : [],
      };
    });
    if (!targets.some((t) => t.final || t.crush !== null || t.skid !== null || t.pins?.length)) return toast('Marca al menos un dato observado (posición final, posiciones en un instante, daños o huella).', 'error');
    // los valores actuales dentro de los límites
    for (const q of params) q.value = Math.min(q.max, Math.max(q.min, q.value));
    const input = ed.world.simInput();
    input.end = Math.max(input.end, 12); // dejar que lleguen al reposo
    const pb: FitProblem = { input, params, targets };
    running = true;
    cancel = false;
    runBtn.disabled = true;
    closeBtn.textContent = 'Detener';
    body.classList.add('busy');
    ed.vp.paused = true; // la escena queda tapada: todo el procesador para las simulaciones
    clear(resultsEl);
    const bar = h('div', { class: 'fit-bar' }, h('div'));
    const txt = h('div', { class: 'muted' }, 'Preparando…');
    clear(progress);
    progress.append(bar, txt);
    const t0 = performance.now();
    let lastYield = t0;
    const r = await fit(pb, {
      cancelled: () => cancel,
      // ceder el control de vez en cuando para que la interfaz responda (no tras cada simulación)
      yieldEvery: () => {
        if (performance.now() - lastYield < 150) return Promise.resolve();
        return new Promise((res) => setTimeout(() => ((lastYield = performance.now()), res()), 0));
      },
      onProgress: ({ evals, total, best, phase }) => {
        (bar.firstChild as HTMLElement).style.width = `${Math.min(100, (evals / total) * 100)}%`;
        txt.textContent = `${phase}… ${evals} simulaciones · discrepancia ${fmt(best.cost, 1)}`;
      },
    });
    running = false;
    ed.vp.paused = false;
    runBtn.disabled = false;
    runBtn.textContent = 'Buscar otra vez';
    closeBtn.textContent = 'Cerrar';
    body.classList.remove('busy');
    if (!ov.isConnected) return;
    txt.textContent = `${r.cancelled ? 'Detenido' : 'Terminado'}: ${r.evals} simulaciones en ${fmt((performance.now() - t0) / 1000, 1)} s.`;
    (bar.firstChild as HTMLElement).style.width = '100%';
    result = { r, params, pb };
    renderResult();
  };

  const renderResult = () => {
    clear(resultsEl);
    if (!result) return;
    const { r, params } = result;
    const lbl = (id: string) => observed.find((v) => v.id === id)?.label ?? id;
    resultsEl.append(h('div', { class: 'cat-title' }, 'Resultado'));
    const ok = good(r.best.errors);
    resultsEl.append(
      h(
        'p',
        { class: ok ? 'ok' : 'warn' },
        ok
          ? 'La simulación cuadra con lo observado.'
          : 'No se consigue cuadrar del todo. Revisa la ruta de cada vehículo y el punto de colisión, amplía los límites o añade incógnitas (por ejemplo, un volantazo).',
      ),
    );
    const t = h('table', { class: 'fit-table' });
    t.append(h('tr', {}, h('th', {}, 'Vehículo'), h('th', {}, 'Valor'), h('th', {}, 'Antes'), h('th', {}, 'Propuesto'), h('th', { title: 'Valores con los que la simulación sigue cuadrando dentro de la precisión de un croquis (≈ 2 m)' }, 'Margen compatible')));
    const v0Before = applyParams(result.pb.input.vehicles, params, r.initial.x, result.pb.input);
    const v0After = applyParams(result.pb.input.vehicles, params, r.best.x, result.pb.input);
    params.forEach((q, i) => {
      const rg = r.ranges[i];
      t.append(h('tr', {}, h('td', {}, lbl(q.veh)), h('td', {}, q.label), h('td', {}, fmtVal(q, r.initial.x[i])), h('td', {}, h('strong', {}, fmtVal(q, r.best.x[i]))), h('td', {}, rg ? `${fmtVal(q, rg[0])} – ${fmtVal(q, rg[1])}` : '—')));
      if (q.kind === 'impact') {
        const sp = (list: VehicleEntity[]) => list.find((v) => v.id === q.veh)?.drive?.speed ?? 0;
        t.append(
          h(
            'tr',
            { class: 'derived' },
            h('td', {}, ''),
            h('td', {}, '↳ velocidad inicial (deducida de sus maniobras)'),
            h('td', {}, `${Math.round(sp(v0Before))} km/h`),
            h('td', {}, h('strong', {}, `${Math.round(sp(v0After))} km/h`)),
            h('td', {}, ''),
          ),
        );
      }
    });
    resultsEl.append(t);
    if (r.alternatives.length) {
      resultsEl.append(
        h(
          'p',
          { class: 'warn' },
          `Ojo: hay ${r.alternatives.length === 1 ? 'otra combinación claramente distinta que también cuadra' : `${r.alternatives.length} combinaciones claramente distintas que también cuadran`}. Con estos datos la solución no es única: un dato más (una huella medida, el aplastamiento de las fotos, la posición final de otro elemento) ayudaría a decidir.`,
        ),
      );
      const at = h('table', { class: 'fit-table' });
      at.append(h('tr', {}, ...params.map((q) => h('th', {}, `${lbl(q.veh)} · ${q.label}`)), h('th', {}, 'Peor posición final'), h('th', {}, '')));
      for (const alt of r.alternatives) {
        const worst = Math.max(...alt.errors.map((e) => e.dist ?? 0));
        at.append(
          h(
            'tr',
            {},
            ...params.map((q, i) => h('td', {}, fmtVal(q, alt.x[i]))),
            h('td', {}, `${fmt(worst, 1)} m`),
            h(
              'td',
              {},
              h(
                'button',
                {
                  class: 'btn small',
                  onclick: () => {
                    // intercambiar: la elegida pasa a ser la propuesta (sus márgenes no se han calculado)
                    r.alternatives = [r.best, ...r.alternatives.filter((a) => a !== alt)];
                    r.best = alt;
                    r.ranges = params.map(() => null as unknown as [number, number]);
                    renderResult();
                  },
                },
                'Usar esta',
              ),
            ),
          ),
        );
      }
      resultsEl.append(at);
    }
    const errs = h('div', { class: 'fit-errs' });
    for (const e of r.best.errors) {
      const before = r.initial.errors.find((x) => x.veh === e.veh)!;
      errs.append(h('div', {}, h('span', { class: 'muted' }, 'Antes · '), describeErr(before, lbl(e.veh))), h('div', {}, h('span', { class: 'muted' }, 'Ahora · '), h('strong', {}, describeErr(e, lbl(e.veh)))));
    }
    resultsEl.append(
      errs,
      h(
        'p',
        { class: 'muted' },
        'El margen es orientativo: cuánto puede variar cada valor alrededor de esta solución, con el resto fijo, sin salirse de la precisión de un croquis. No es un cálculo pericial.',
      ),
      h(
        'div',
        { class: 'row', style: 'gap:8px' },
        h('button', { class: 'btn primary', onclick: () => apply() }, 'Aplicar a la reconstrucción'),
        h('button', { class: 'btn', onclick: () => ((result = null), clear(resultsEl)) }, 'Descartar'),
      ),
    );
  };

  const apply = () => {
    if (!result) return;
    const { r, params, pb } = result;
    const full = evaluate(pb, r.best.x);
    const rests = [...full.res.vehicles.values()].map((sv) => sv.restTime ?? pb.input.end);
    const solved = applyParams(pb.input.vehicles, params, r.best.x, pb.input);
    store.edit(
      () => {
        params.forEach((q, i) => {
          const v = store.get(q.veh) as VehicleEntity | undefined;
          if (!v?.drive) return;
          const x = q.kind === 'speed' || q.unit === '°' ? Math.round(r.best.x[i] * 10) / 10 : Math.round(r.best.x[i] * 100) / 100;
          v.drive.speedAuto = false; // la velocidad la fija el ajuste
          if (q.kind === 'speed') v.drive.speed = x;
          else if (q.kind === 'impact') v.drive.speed = Math.round((solved.find((o) => o.id === v.id)?.drive?.speed ?? v.drive.speed) * 10) / 10;
          else {
            const ev = v.drive.events.find((e) => e.id === q.event);
            if (ev) {
              if (q.kind === 'evT') ev.t = x;
              else ev.value = x;
            }
          }
        });
        for (const v of driven) {
          const live = store.get(v.id) as VehicleEntity | undefined;
          if (!live?.drive) continue;
          const o = obs.get(v.id)!;
          live.drive.skidObs = o.skid;
          if (o.final) live.drive.showFinal = true;
        }
        // con posiciones del croquis, el inicio se recalcula con las nuevas velocidades
        applyAllMarks(ed.world, store.project);
        // que la animación llegue hasta el reposo
        const restEnd = Math.ceil(Math.max(...rests) + 1);
        const tl = store.project.timeline ?? { start: range.start, end: range.end };
        if (restEnd > tl.end) store.project.timeline = { start: tl.start, end: Math.min(restEnd, 15) };
      },
      { type: 'env' },
    );
    toast('Valores aplicados. Pulsa reproducir para ver la reconstrucción.');
    close();
  };

  renderForm();
  document.body.append(ov);
  if (opts.autoRun) setTimeout(() => run(), 50);
}
