import type { DriverEvent, VehicleEntity } from '../model/types';
import { frameAt, simulate, soloSpeedAt, type SimInput, type SimResult } from './sim';

/**
 * Ajuste automático («reconstrucción inversa»): busca los valores desconocidos de la conducción
 * (velocidad inicial, instante e intensidad de la frenada, volantazo…) para los que la simulación
 * reproduce lo observado: la posición final de cada vehículo según el croquis y la profundidad de
 * los daños medida en las fotos.
 *
 * Método: muestreo inicial del espacio de búsqueda + Nelder–Mead acotado sobre el mejor punto, y
 * después un barrido por parámetro para dar un rango plausible (valores que siguen cuadrando).
 */

/**
 * speed: velocidad inicial · impact: velocidad en el impacto (la inicial se deduce de ella y de las
 * maniobras previas, como en una reconstrucción clásica) · evT / evV: instante / valor de una acción.
 */
export type ParamKind = 'speed' | 'impact' | 'evT' | 'evV';

export interface FitParam {
  veh: string;
  kind: ParamKind;
  /** Evento del conductor afectado (evT, evV). */
  event?: string;
  min: number;
  max: number;
  /** Valor actual. */
  value: number;
  label: string;
  unit: string;
}

export interface FitTarget {
  veh: string;
  /** Posición final observada (centro, rumbo en grados). */
  final: { x: number; z: number; h: number } | null;
  /** Profundidad máxima de daños observada (m). */
  crush: number | null;
  /** Longitud de huella de frenada antes del impacto observada (m). */
  skid: number | null;
  /** Posiciones observadas en instantes concretos. */
  pins?: { t: number; x: number; z: number; h: number }[];
}

export interface FitProblem {
  input: SimInput;
  params: FitParam[];
  targets: FitTarget[];
}

export interface TargetError {
  veh: string;
  dist: number | null;
  dh: number | null;
  crushSim: number | null;
  crushObs: number | null;
  skidSim: number | null;
  skidObs: number | null;
  moving: number;
  contact: boolean;
  pins: { t: number; dist: number; dh: number }[];
}

export interface FitEval {
  x: number[];
  cost: number;
  errors: TargetError[];
}

export interface FitResult {
  best: FitEval;
  /** Otras combinaciones claramente distintas que también cuadran (el problema puede no tener solución única). */
  alternatives: FitEval[];
  initial: FitEval;
  ranges: [number, number][];
  evals: number;
  cancelled: boolean;
}

/** Escalas de error: 1 m de posición equivale a 10° de rumbo, a 15 cm de aplastamiento y a 1,5 m de huella. */
const SIGMA = { pos: 1, ang: 10, crush: 0.15, skid: 1.5 };

/** Huella de frenada más larga antes del primer contacto (m). */
export function skidLength(res: SimResult, veh: string): number {
  const sv = res.vehicles.get(veh);
  if (!sv) return 0;
  const tc = sv.firstContact ?? Infinity;
  let best = 0;
  for (const m of sv.marks) {
    let L = 0;
    for (let i = 1; i < m.pts.length; i++) {
      if (m.pts[i].t > tc) break;
      L += Math.hypot(m.pts[i].x - m.pts[i - 1].x, m.pts[i].z - m.pts[i - 1].z);
    }
    best = Math.max(best, L);
  }
  return best;
}

/** Parámetros candidatos de un vehículo con conducción (para que el usuario elija cuáles son libres). */
/**
 * Con el punto de colisión fijado y alguna acción sobre los pedales antes del impacto, la incógnita
 * de velocidad es la del impacto: es la que decide el choque y las posiciones finales, mientras que
 * el instante de la frenada solo cambia la velocidad inicial y la huella. Así las incógnitas quedan
 * casi independientes y la búsqueda converge mucho mejor.
 */
export function usesImpactSpeed(v: VehicleEntity): boolean {
  const d = v.drive;
  return !!d && d.sync && v.spec.tipo !== 'peaton' && d.events.some((e) => e.t < 0 && (e.action === 'frenar' || e.action === 'acelerar' || e.action === 'soltar'));
}

export function candidateParams(v: VehicleEntity, start = -6, impactKmh: number | null = null): FitParam[] {
  const d = v.drive;
  if (!d) return [];
  const ped = v.spec.tipo === 'peaton';
  const out: FitParam[] =
    usesImpactSpeed(v) && impactKmh !== null
      ? [{ veh: v.id, kind: 'impact', min: 5, max: 160, value: impactKmh, label: 'Velocidad en el impacto', unit: 'km/h' }]
      : [{ veh: v.id, kind: 'speed', min: ped ? 2 : 10, max: ped ? 20 : 160, value: d.speed, label: 'Velocidad inicial', unit: 'km/h' }];
  const names: Record<DriverEvent['action'], string> = { frenar: 'Frenada', acelerar: 'Aceleración', soltar: 'Soltar pedales', girar: 'Volantazo', recto: 'Volver a la ruta' };
  for (const ev of d.events) {
    out.push({ veh: v.id, kind: 'evT', event: ev.id, min: Math.min(start, ev.t), max: Math.max(0.5, ev.t), value: ev.t, label: `${names[ev.action]}: instante`, unit: 's' });
    if (ev.action === 'frenar' || ev.action === 'acelerar')
      out.push({ veh: v.id, kind: 'evV', event: ev.id, min: 0.1, max: 1, value: ev.value, label: `${names[ev.action]}: intensidad`, unit: '×' });
    if (ev.action === 'girar') out.push({ veh: v.id, kind: 'evV', event: ev.id, min: -25, max: 25, value: ev.value, label: `${names[ev.action]}: grados de rueda`, unit: '°' });
  }
  return out;
}

/** Velocidad inicial (km/h) con la que el vehículo llega al impacto a vImp (km/h) con sus maniobras. */
export function initialSpeedFor(v: VehicleEntity, input: SimInput, vImp: number): number {
  let v0 = vImp;
  const at = (s: number) => soloSpeedAt({ ...v, drive: { ...v.drive!, speed: s } }, input, 0) * 3.6;
  // la caída de velocidad por frenar un tiempo dado es casi independiente de la velocidad inicial
  for (let it = 0; it < 4; it++) {
    const got = at(v0);
    const err = vImp - got;
    if (Math.abs(err) < 0.3) break;
    v0 = Math.min(250, Math.max(vImp, v0 + (got <= 0.5 ? Math.max(err, 10) : err)));
  }
  return v0;
}

/** Copia de los vehículos con los parámetros aplicados. */
export function applyParams(vehicles: VehicleEntity[], params: FitParam[], x: number[], input?: SimInput): VehicleEntity[] {
  const out = vehicles.map((v) => (v.drive ? { ...v, drive: { ...v.drive, events: v.drive.events.map((e) => ({ ...e })) } } : v));
  const impacts: [VehicleEntity, number][] = [];
  params.forEach((p, i) => {
    const v = out.find((o) => o.id === p.veh);
    if (!v?.drive) return;
    if (p.kind === 'speed') v.drive.speed = x[i];
    else if (p.kind === 'impact') impacts.push([v, x[i]]);
    else {
      const ev = v.drive.events.find((e) => e.id === p.event);
      if (!ev) return;
      if (p.kind === 'evT') ev.t = x[i];
      else ev.value = x[i];
    }
  });
  // con las maniobras ya aplicadas, deducir la velocidad inicial de la del impacto
  for (const [v, vImp] of impacts) if (input) v.drive!.speed = initialSpeedFor(v, input, vImp);
  return out;
}

const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

export function measure(res: SimResult, targets: FitTarget[], impact: boolean): { cost: number; errors: TargetError[] } {
  let cost = 0;
  const errors: TargetError[] = [];
  for (const tg of targets) {
    const sv = res.vehicles.get(tg.veh);
    if (!sv) continue;
    const last = sv.frames[sv.frames.length - 1];
    const err: TargetError = { veh: tg.veh, dist: null, dh: null, crushSim: null, crushObs: tg.crush, skidSim: null, skidObs: tg.skid, moving: last.v, contact: sv.firstContact !== null, pins: [] };
    if (tg.final) {
      err.dist = Math.hypot(last.x - tg.final.x, last.z - tg.final.z);
      err.dh = angDiff(last.h, tg.final.h);
      cost += (err.dist / SIGMA.pos) ** 2 + (err.dh / SIGMA.ang) ** 2;
      // seguir en marcha al final no es un reposo
      cost += (last.v / 2) ** 2;
    }
    if (tg.crush !== null) {
      err.crushSim = Math.max(0, ...sv.autoDamage.map((z) => z.depth));
      cost += ((err.crushSim - tg.crush) / SIGMA.crush) ** 2;
    }
    if (tg.skid !== null) {
      err.skidSim = skidLength(res, tg.veh);
      cost += ((err.skidSim - tg.skid) / SIGMA.skid) ** 2;
    }
    for (const pn of tg.pins ?? []) {
      const f = frameAt(sv, pn.t);
      const dist = Math.hypot(f.x - pn.x, f.z - pn.z);
      const dh = angDiff(f.h, pn.h);
      err.pins.push({ t: pn.t, dist, dh });
      cost += (dist / SIGMA.pos) ** 2 + (dh / SIGMA.ang) ** 2;
    }
    if (impact && !err.contact) cost += 400;
    errors.push(err);
  }
  return { cost, errors };
}

/** Evalúa un juego de parámetros (una simulación completa). */
export function evaluate(pb: FitProblem, x: number[]): FitEval & { res: SimResult } {
  const vehicles = applyParams(pb.input.vehicles, pb.params, x, pb.input);
  const res = simulate({ ...pb.input, vehicles });
  const { cost, errors } = measure(res, pb.targets, !!pb.input.impact);
  return { x: [...x], cost, errors, res };
}

export interface FitOptions {
  maxEvals?: number;
  onProgress?: (p: { evals: number; total: number; best: FitEval; phase: string }) => void;
  cancelled?: () => boolean;
  /** Pausa entre simulaciones para no bloquear la interfaz (navegador). */
  yieldEvery?: () => Promise<void>;
  seed?: number;
}

/** Generador pseudoaleatorio reproducible (xorshift). */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

export async function fit(pb: FitProblem, opt: FitOptions = {}): Promise<FitResult> {
  const n = pb.params.length;
  const total = opt.maxEvals ?? Math.min(900, 380 + 60 * n);
  const lo = pb.params.map((p) => p.min);
  const hi = pb.params.map((p) => p.max);
  const toX = (u: number[]) => u.map((v, i) => lo[i] + Math.min(1, Math.max(0, v)) * (hi[i] - lo[i]));
  const toU = (x: number[]) => x.map((v, i) => (hi[i] > lo[i] ? (v - lo[i]) / (hi[i] - lo[i]) : 0));
  let evals = 0;
  let extra = 0;
  let best: FitEval | null = null;
  const cache = new Map<string, number>();
  const log: (FitEval & { u: number[] })[] = [];
  const report = (phase: string) => opt.onProgress?.({ evals, total, best: best!, phase });
  const stop = () => evals >= total || !!opt.cancelled?.();

  const f = async (u: number[]): Promise<number> => {
    const uc = u.map((v) => Math.min(1, Math.max(0, v)));
    const key = uc.map((v) => v.toFixed(4)).join(',');
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const ev = evaluate(pb, toX(uc));
    evals++;
    // penalización suave por salirse de los límites (Nelder–Mead sin restricciones)
    const out = u.reduce((s, v) => s + Math.max(0, -v, v - 1) ** 2, 0) * 100;
    const c = ev.cost + out;
    cache.set(key, c);
    log.push({ u: uc, x: ev.x, cost: ev.cost, errors: ev.errors });
    if (!best || ev.cost < best.cost) best = { x: ev.x, cost: ev.cost, errors: ev.errors };
    if (opt.yieldEvery) await opt.yieldEvery();
    return c;
  };

  // 0) punto de partida (valores actuales)
  const u0 = toU(pb.params.map((p) => p.value));
  await f(u0);
  const initial = { ...best! };
  report('Punto de partida');

  // 1) búsqueda global: evolución diferencial (población que se recombina; tolera un paisaje
  //    con saltos, porque un pequeño cambio puede dar un choque distinto)
  const rand = rng(opt.seed ?? 20240611);
  const NP = Math.max(14, 6 * n);
  const deBudget = Math.floor(total * 0.75);
  const pop: { u: number[]; c: number }[] = [{ u: u0, c: initial.cost }];
  const seeds: number[][] = [];
  // 1a) las velocidades son lo que más pesa: rejilla sobre ellas (el resto, en sus valores actuales)
  const spIdx = pb.params.map((p, i) => (p.kind === 'speed' || p.kind === 'impact' ? i : -1)).filter((i) => i >= 0);
  if (spIdx.length >= 1 && spIdx.length <= 2) {
    const G = spIdx.length === 1 ? 31 : 17;
    const grid: { u: number[]; c: number }[] = [];
    const vals = Array.from({ length: G }, (_, k) => (k + 0.5) / G);
    const combos = spIdx.length === 1 ? vals.map((a) => [a]) : vals.flatMap((a) => vals.map((b) => [a, b]));
    for (const cmb of combos) {
      if (stop()) break;
      const u = [...u0];
      spIdx.forEach((ix, k) => (u[ix] = cmb[k]));
      grid.push({ u, c: await f(u) });
      if (grid.length % 10 === 0) report('Explorando velocidades');
    }
    grid.sort((a, b) => a.c - b.c);
    pop.push(...grid.slice(0, Math.ceil(NP / 2)));
    // regiones prometedoras distintas (para buscar después otras soluciones posibles)
    for (const g of grid) {
      if (seeds.length >= 4) break;
      if (seeds.every((q) => Math.max(...q.map((v, i) => Math.abs(v - g.u[i]))) > 0.15)) seeds.push(g.u);
    }
  }
  while (pop.length < NP && !stop()) {
    const u = pb.params.map(() => rand());
    pop.push({ u, c: await f(u) });
    report('Explorando');
  }
  while (evals < deBudget && !stop()) {
    for (let k = 0; k < pop.length && evals < deBudget && !stop(); k++) {
      const bestIdx = pop.reduce((bi, p, i) => (p.c < pop[bi].c ? i : bi), 0);
      let a: number, b: number, c: number;
      do a = Math.floor(rand() * pop.length); while (a === k);
      do b = Math.floor(rand() * pop.length); while (b === k || b === a);
      do c = Math.floor(rand() * pop.length); while (c === k || c === a || c === b);
      // mezcla de rand/1 y current-to-best para equilibrar exploración y convergencia
      const F = 0.5 + 0.3 * rand();
      const jr = Math.floor(rand() * n);
      const toBest = rand() < 0.5;
      const trial = pop[k].u.map((v, j) => {
        if (j !== jr && rand() > 0.9) return v;
        const m = toBest ? v + F * (pop[bestIdx].u[j] - v) + F * (pop[b].u[j] - pop[c].u[j]) : pop[a].u[j] + F * (pop[b].u[j] - pop[c].u[j]);
        // rebote en los límites
        return m < 0 ? rand() * v : m > 1 ? v + rand() * (1 - v) : m;
      });
      const ct = await f(trial);
      if (ct <= pop[k].c) pop[k] = { u: trial, c: ct };
    }
    report('Explorando');
  }

  // 1b) barridos locales por coordenadas alrededor del mejor (ventana menguante)
  let cur = toU(best!.x);
  let curC = best!.cost;
  let win = 0.2;
  for (let cycle = 0; cycle < 2 && !stop(); cycle++) {
    for (let i = 0; i < n && !stop(); i++) {
      const a = Math.max(0, cur[i] - win / 2);
      const b = Math.min(1, cur[i] + win / 2);
      for (let k = 0; k < 7 && !stop(); k++) {
        const u = [...cur];
        u[i] = a + ((b - a) * k) / 6;
        const c = await f(u);
        if (c < curC) {
          curC = c;
          cur = u;
        }
      }
    }
    report('Afinando');
    win *= 0.4;
  }

  // 2) Nelder–Mead desde el mejor punto (reinicios con paso menor si sobra presupuesto)
  const nm = async (start: number[], step: number, budget = Infinity) => {
    const limit = evals + budget;
    const stop = () => evals >= total + extra || evals >= limit || !!opt.cancelled?.() || (budget === Infinity && evals >= total);
    let simplex: { u: number[]; c: number }[] = [{ u: start, c: await f(start) }];
    for (let i = 0; i < n; i++) {
      const u = [...start];
      u[i] = u[i] + (u[i] + step <= 1 ? step : -step);
      simplex.push({ u, c: await f(u) });
    }
    let stall = 0;
    while (!stop()) {
      simplex.sort((a, b) => a.c - b.c);
      const spread = Math.max(...simplex.map((s) => Math.max(...s.u.map((v, i) => Math.abs(v - simplex[0].u[i])))));
      if (spread < 0.003 || stall > 6 * n + 10) break;
      const worst = simplex[n];
      const cen = Array.from({ length: n }, (_, i) => simplex.slice(0, n).reduce((s, p) => s + p.u[i], 0) / n);
      const pt = (a: number) => cen.map((c, i) => c + a * (worst.u[i] - c));
      const prevBest = simplex[0].c;
      const r = pt(-1);
      const cr = await f(r);
      if (cr < simplex[0].c) {
        const e = pt(-2);
        const ce = await f(e);
        simplex[n] = ce < cr ? { u: e, c: ce } : { u: r, c: cr };
      } else if (cr < simplex[n - 1].c) simplex[n] = { u: r, c: cr };
      else {
        const k = cr < worst.c ? pt(-0.5) : pt(0.5);
        const ck = await f(k);
        if (ck < Math.min(cr, worst.c)) simplex[n] = { u: k, c: ck };
        else {
          // encoger hacia el mejor
          const b0 = simplex[0].u;
          for (let j = 1; j <= n && !stop(); j++) {
            const u = simplex[j].u.map((v, i) => b0[i] + 0.5 * (v - b0[i]));
            simplex[j] = { u, c: await f(u) };
          }
        }
      }
      simplex.sort((a, b) => a.c - b.c);
      stall = simplex[0].c < prevBest - 1e-3 ? 0 : stall + 1;
      report('Afinando');
    }
  };

  let step = Math.max(0.02, win);
  for (let r = 0; r < 3 && !stop(); r++) {
    await nm(toU(best!.x), step);
    step *= 0.5;
  }

  // 2b) afinar también las otras regiones prometedoras: el problema puede tener varias soluciones
  const mainU = toU(best!.x);
  extra = 45 * Math.min(3, seeds.length);
  for (const sd of seeds) {
    if (opt.cancelled?.()) break;
    if (Math.max(...sd.map((v, i) => Math.abs(v - mainU[i]))) < 0.08) continue;
    await nm(sd, 0.04, 45);
    report('Buscando otras soluciones');
  }

  // 3) rango plausible por parámetro: hasta dónde se puede mover sin empeorar más de un umbral
  const bestU = toU(best!.x);
  const bestCost = best!.cost;
  // tolerancia: la incertidumbre propia de un croquis (≈ 2 m o 20° por posición, 30 cm de daños, 3 m de huella)
  const terms = pb.targets.reduce((s, t) => s + (t.final ? 1 : 0) + (t.crush !== null ? 1 : 0) + (t.skid !== null ? 1 : 0) + (t.pins?.length ?? 0), 0);
  const tol = bestCost + 4 * Math.max(1, terms);
  const ranges: [number, number][] = [];
  const save = best!;
  for (let i = 0; i < n; i++) {
    const side = async (dir: number) => {
      const u = [...bestU];
      const probe = async (v: number) => {
        u[i] = v;
        const ev = evaluate(pb, toX(u));
        evals++;
        if (opt.yieldEvery) await opt.yieldEvery();
        return ev.cost <= tol;
      };
      // salir hacia fuera doblando el paso hasta dejar de cuadrar, y después bisecar
      let inside = bestU[i];
      let d = 0.01;
      let outside: number | null = null;
      while (outside === null && !opt.cancelled?.()) {
        const v = Math.min(1, Math.max(0, bestU[i] + dir * d));
        if (await probe(v)) {
          inside = v;
          if (v === 0 || v === 1) return v;
          d *= 2;
        } else outside = v;
      }
      if (outside === null) return inside;
      let out: number = outside;
      for (let k = 0; k < 4 && !opt.cancelled?.(); k++) {
        const mid: number = (inside + out) / 2;
        if (await probe(mid)) inside = mid;
        else out = mid;
      }
      return inside;
    };
    const a = await side(-1);
    const b = await side(1);
    ranges.push([lo[i] + a * (hi[i] - lo[i]), lo[i] + b * (hi[i] - lo[i])]);
    opt.onProgress?.({ evals, total: total + 12 * n, best: save, phase: 'Calculando márgenes' });
  }
  // soluciones alternativas: buenas y alejadas entre sí (al menos un 8 % del rango en algún valor)
  const alternatives: FitEval[] = [];
  const picked = [bestU];
  for (const e of [...log].sort((a, b) => a.cost - b.cost)) {
    if (e.cost > tol || alternatives.length >= 3) break;
    if (picked.every((p) => Math.max(...p.map((v, i) => Math.abs(v - e.u[i]))) > 0.08)) {
      picked.push(e.u);
      alternatives.push({ x: e.x, cost: e.cost, errors: e.errors });
    }
  }
  return { best: save, alternatives, initial, ranges, evals, cancelled: !!opt.cancelled?.() };
}
