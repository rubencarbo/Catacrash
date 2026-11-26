import type { SpecKey, VehicleSpec, VehicleType } from '../model/types';

/** Valores típicos por tipo de vehículo (m, kg). */
interface Typical {
  label: string;
  grupo: 'Turismos' | 'Comerciales e industriales' | 'Dos ruedas y otros';
  L: number;
  W: number;
  H: number;
  batalla: number;
  via: number;
  volD: number;
  masa: number;
  rueda: number;
  /** Altura del CDG como fracción de H. */
  cdg: number;
  /** Posición del CDG desde el eje delantero como fracción de la batalla. */
  reparto: number;
  traccion: VehicleSpec['traccion'];
}

export const TYPICAL: Record<VehicleType, Typical> = {
  urbano: { label: 'Urbano / utilitario', grupo: 'Turismos', L: 3.75, W: 1.67, H: 1.48, batalla: 2.43, via: 1.45, volD: 0.72, masa: 1030, rueda: 0.6, cdg: 0.37, reparto: 0.38, traccion: 'delantera' },
  compacto: { label: 'Compacto', grupo: 'Turismos', L: 4.3, W: 1.79, H: 1.46, batalla: 2.64, via: 1.54, volD: 0.88, masa: 1300, rueda: 0.63, cdg: 0.37, reparto: 0.39, traccion: 'delantera' },
  berlina: { label: 'Berlina (sedán)', grupo: 'Turismos', L: 4.75, W: 1.83, H: 1.45, batalla: 2.82, via: 1.58, volD: 0.92, masa: 1500, rueda: 0.66, cdg: 0.37, reparto: 0.42, traccion: 'delantera' },
  familiar: { label: 'Familiar', grupo: 'Turismos', L: 4.7, W: 1.83, H: 1.49, batalla: 2.75, via: 1.57, volD: 0.92, masa: 1450, rueda: 0.65, cdg: 0.38, reparto: 0.42, traccion: 'delantera' },
  coupe: { label: 'Coupé / deportivo / cabrio', grupo: 'Turismos', L: 4.5, W: 1.85, H: 1.33, batalla: 2.65, via: 1.58, volD: 0.95, masa: 1450, rueda: 0.66, cdg: 0.34, reparto: 0.45, traccion: 'trasera' },
  suv: { label: 'SUV / crossover', grupo: 'Turismos', L: 4.35, W: 1.8, H: 1.6, batalla: 2.64, via: 1.55, volD: 0.88, masa: 1400, rueda: 0.68, cdg: 0.41, reparto: 0.4, traccion: 'delantera' },
  suv_grande: { label: 'SUV grande', grupo: 'Turismos', L: 4.75, W: 1.9, H: 1.7, batalla: 2.85, via: 1.63, volD: 0.95, masa: 1850, rueda: 0.74, cdg: 0.42, reparto: 0.44, traccion: 'total' },
  monovolumen: { label: 'Monovolumen', grupo: 'Turismos', L: 4.55, W: 1.82, H: 1.66, batalla: 2.78, via: 1.56, volD: 0.92, masa: 1550, rueda: 0.66, cdg: 0.4, reparto: 0.42, traccion: 'delantera' },
  todoterreno: { label: 'Todoterreno', grupo: 'Turismos', L: 4.65, W: 1.87, H: 1.85, batalla: 2.75, via: 1.58, volD: 0.85, masa: 2100, rueda: 0.78, cdg: 0.44, reparto: 0.47, traccion: 'total' },
  pickup: { label: 'Pick-up', grupo: 'Comerciales e industriales', L: 5.3, W: 1.86, H: 1.82, batalla: 3.1, via: 1.55, volD: 0.95, masa: 2000, rueda: 0.78, cdg: 0.43, reparto: 0.42, traccion: 'total' },
  furgoneta: { label: 'Furgoneta (tipo Berlingo/Kangoo)', grupo: 'Comerciales e industriales', L: 4.4, W: 1.85, H: 1.82, batalla: 2.78, via: 1.55, volD: 0.86, masa: 1450, rueda: 0.64, cdg: 0.42, reparto: 0.43, traccion: 'delantera' },
  furgon: { label: 'Furgón (tipo Sprinter/Transit)', grupo: 'Comerciales e industriales', L: 5.93, W: 2.02, H: 2.68, batalla: 3.66, via: 1.72, volD: 0.97, masa: 2100, rueda: 0.72, cdg: 0.4, reparto: 0.45, traccion: 'trasera' },
  camion: { label: 'Camión rígido', grupo: 'Comerciales e industriales', L: 8.5, W: 2.5, H: 3.4, batalla: 4.8, via: 2.0, volD: 1.4, masa: 7000, rueda: 0.95, cdg: 0.4, reparto: 0.4, traccion: 'trasera' },
  tractora: { label: 'Cabeza tractora', grupo: 'Comerciales e industriales', L: 6.0, W: 2.5, H: 3.9, batalla: 3.8, via: 2.04, volD: 1.4, masa: 8000, rueda: 1.0, cdg: 0.33, reparto: 0.35, traccion: 'trasera' },
  autobus: { label: 'Autobús', grupo: 'Comerciales e industriales', L: 12.0, W: 2.55, H: 3.2, batalla: 5.9, via: 2.1, volD: 2.7, masa: 12000, rueda: 1.0, cdg: 0.42, reparto: 0.55, traccion: 'trasera' },
  moto: { label: 'Motocicleta', grupo: 'Dos ruedas y otros', L: 2.1, W: 0.8, H: 1.15, batalla: 1.42, via: 0, volD: 0.3, masa: 190, rueda: 0.62, cdg: 0.5, reparto: 0.5, traccion: 'trasera' },
  ciclomotor: { label: 'Ciclomotor / scooter', grupo: 'Dos ruedas y otros', L: 1.85, W: 0.7, H: 1.12, batalla: 1.3, via: 0, volD: 0.28, masa: 105, rueda: 0.5, cdg: 0.48, reparto: 0.55, traccion: 'trasera' },
  bicicleta: { label: 'Bicicleta', grupo: 'Dos ruedas y otros', L: 1.75, W: 0.6, H: 1.05, batalla: 1.05, via: 0, volD: 0.35, masa: 13, rueda: 0.7, cdg: 0.55, reparto: 0.55, traccion: 'trasera' },
  patinete: { label: 'Patinete eléctrico', grupo: 'Dos ruedas y otros', L: 1.1, W: 0.45, H: 1.2, batalla: 0.85, via: 0, volD: 0.12, masa: 15, rueda: 0.22, cdg: 0.3, reparto: 0.5, traccion: 'trasera' },
  peaton: { label: 'Peatón', grupo: 'Dos ruedas y otros', L: 0.3, W: 0.5, H: 1.75, batalla: 0, via: 0, volD: 0, masa: 75, rueda: 0, cdg: 0.56, reparto: 0.5, traccion: 'trasera' },
};

export const TWO_WHEELS: VehicleType[] = ['moto', 'ciclomotor', 'bicicleta', 'patinete'];

const r2 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Completa los datos que faltan con estimaciones coherentes con el tipo y las medidas conocidas.
 * Nunca sobrescribe un dato cuyo origen sea catálogo o ficha.
 */
export function completeSpec(p: Partial<VehicleSpec> & { tipo: VehicleType }): VehicleSpec {
  const t = TYPICAL[p.tipo];
  const origen: VehicleSpec['origen'] = { ...(p.origen ?? {}) };
  const has = (k: SpecKey) => p[k] !== undefined && p[k] !== null && Number.isFinite(p[k] as number) && (p[k] as number) > 0;
  const est = (k: SpecKey, v: number) => {
    if (has(k)) {
      origen[k] ??= 'catalogo';
      return p[k] as number;
    }
    origen[k] = p.L || p.W ? 'estimado' : 'generico';
    return r2(v);
  };
  const L = est('L', t.L);
  const W = est('W', t.W * (has('L') ? Math.min(1.15, Math.max(0.85, L / t.L)) ** 0.3 : 1));
  const H = est('H', t.H);
  const batalla = est('batalla', L * (t.batalla / t.L || 0));
  const via = t.via * (W / t.W);
  const viaD = est('viaD', via);
  const viaT = est('viaT', has('viaD') ? (p.viaD as number) : via);
  const resto = Math.max(0, L - batalla);
  const volD = est('volD', has('volT') ? Math.max(0, resto - (p.volT as number)) : resto * (t.volD / Math.max(0.01, t.L - t.batalla) || 0.5));
  const volT = est('volT', Math.max(0, L - batalla - volD));
  const masa = est('masa', t.masa * ((L * W * H) / (t.L * t.W * t.H)) ** 0.8);
  const rueda = est('rueda', t.rueda * (has('H') ? Math.min(1.2, Math.max(0.85, H / t.H)) ** 0.5 : 1));
  const cdgAltura = est('cdgAltura', H * t.cdg);
  const cdgEje = est('cdgEje', batalla * t.reparto);
  // Inercia de guiñada: aproximación de caja homogénea corregida (masa concentrada hacia el centro)
  const inercia = est('inercia', (masa * (L * L + W * W)) / 12 * 0.9);
  return {
    tipo: p.tipo,
    marca: p.marca ?? '',
    modelo: p.modelo ?? '',
    version: p.version ?? '',
    anio: p.anio ?? null,
    L,
    W,
    H,
    batalla,
    viaD,
    viaT,
    volD,
    volT,
    masa: Math.round(masa),
    mma: p.mma ?? null,
    rueda,
    traccion: p.traccion ?? t.traccion,
    cdgAltura,
    cdgEje,
    inercia: Math.round(inercia),
    origen,
    url: p.url,
  };
}

export function genericSpec(tipo: VehicleType): VehicleSpec {
  return completeSpec({ tipo });
}

/** Recalcula los estimados tras editar a mano algún dato (los editados pasan a «ficha»). */
export function respec(s: VehicleSpec, changed?: SpecKey): VehicleSpec {
  const origen = { ...s.origen };
  if (changed) origen[changed] = 'ficha';
  const keep: Partial<VehicleSpec> = { tipo: s.tipo, marca: s.marca, modelo: s.modelo, version: s.version, anio: s.anio, mma: s.mma, traccion: s.traccion, url: s.url };
  const keys: SpecKey[] = ['L', 'W', 'H', 'batalla', 'viaD', 'viaT', 'volD', 'volT', 'masa', 'rueda', 'cdgAltura', 'cdgEje', 'inercia'];
  const nextOrigen: VehicleSpec['origen'] = {};
  for (const k of keys) {
    if (origen[k] === 'catalogo' || origen[k] === 'ficha') {
      (keep as Record<string, unknown>)[k] = s[k];
      nextOrigen[k] = origen[k];
    }
  }
  keep.origen = nextOrigen;
  return completeSpec(keep as Partial<VehicleSpec> & { tipo: VehicleType });
}

/** Diámetro de rueda a partir de una medida de neumático («205/55 R16»). */
export function tyreDiameter(s: string): number | null {
  const m = s.match(/(\d{3})\s*\/\s*(\d{2})\s*Z?R?\s*(\d{2})/i);
  if (!m) return null;
  return r2((Number(m[3]) * 25.4 + 2 * Number(m[1]) * (Number(m[2]) / 100)) / 1000);
}

/** Deduce el tipo de vehículo a partir de la carrocería y las medidas. */
export function guessType(body: string, L: number, H: number): VehicleType {
  const b = body.toLowerCase();
  if (/pick/.test(b)) return 'pickup';
  if (/cami[oó]n|chasis|truck/.test(b)) return 'camion';
  if (/furg|van|combi|minibus|bus/.test(b)) return H > 2.1 || L > 5.2 ? 'furgon' : 'furgoneta';
  if (/todoterreno|off-road|off road|4x4/.test(b)) return 'todoterreno';
  if (/suv|todocamino|crossover/.test(b)) return L > 4.6 ? 'suv_grande' : 'suv';
  if (/monovolumen|mpv|minivan/.test(b)) return 'monovolumen';
  if (/coup|cabrio|roadster|descapotable|targa|spider|spyder|speedster/.test(b)) return 'coupe';
  if (/familiar|ranchera|wagon|estate|break|touring|shooting/.test(b)) return 'familiar';
  if (/berlina|sed[aá]n|liftback|fastback/.test(b)) return L < 4.2 ? 'compacto' : 'berlina';
  if (H > 1.75) return L > 5 ? 'furgon' : 'furgoneta';
  if (H > 1.56) return L > 4.6 ? 'suv_grande' : 'suv';
  return L < 3.95 ? 'urbano' : L < 4.5 ? 'compacto' : 'berlina';
}

/** Registro del catálogo (claves tal como las genera scripts/scrape_autodata.py; medidas en mm). */
export interface CatalogRecord {
  marca: string;
  modelo: string;
  generacion: string;
  desde?: number;
  hasta?: number;
  tipo?: string;
  carroceria?: string;
  L?: number;
  W?: number;
  H?: number;
  batalla?: number;
  viaD?: number;
  viaT?: number;
  volD?: number;
  volT?: number;
  masa?: number;
  mma?: number;
  traccion?: string;
  neumaticos?: string;
  fuente?: string;
}

export function specFromRecord(r: CatalogRecord): VehicleSpec {
  const mm = (v?: number) => (v && v > 0 ? v / 1000 : undefined);
  const L = mm(r.L);
  const H = mm(r.H);
  const tipo = guessType(`${r.carroceria ?? ''} ${r.tipo ?? ''}`, L ?? 4.3, H ?? 1.5);
  const tr = (r.traccion ?? '').toLowerCase();
  const p: Partial<VehicleSpec> & { tipo: VehicleType } = {
    tipo,
    marca: r.marca,
    modelo: r.modelo,
    version: r.generacion.replace(new RegExp(`^${r.marca}\\s+`, 'i'), ''),
    anio: r.desde ?? null,
    L,
    W: mm(r.W),
    H,
    batalla: mm(r.batalla),
    viaD: mm(r.viaD),
    viaT: mm(r.viaT),
    volD: mm(r.volD),
    volT: mm(r.volT),
    masa: r.masa,
    mma: r.mma ?? null,
    rueda: r.neumaticos ? (tyreDiameter(r.neumaticos) ?? undefined) : undefined,
    traccion: /total|4x4|integral|awd|4wd/.test(tr) ? 'total' : /trasera/.test(tr) ? 'trasera' : 'delantera',
    url: r.fuente,
  };
  return completeSpec(p);
}

// ---------- Ficha pegada ----------

const LABELS: [SpecKey, RegExp][] = [
  ['L', /(?:longitud|largo|length)(?!\s*(?:del\s+)?(?:maletero|carga|caja))/i],
  ['W', /(?:anchura|ancho|width)(?!\s*(?:incl|con\s+espejos|including|with mirrors|del\s+maletero))/i],
  ['H', /(?:altura|alto|height)(?!\s*(?:libre|al\s+suelo|del\s+suelo|ground))/i],
  ['batalla', /(?:distancia\s+entre\s+ejes|batalla|wheelbase)/i],
  ['viaD', /(?:v[ií]a\s+(?:delantera|anterior)|front\s+track)/i],
  ['viaT', /(?:v[ií]a\s+(?:trasera|posterior)|rear\s+(?:back\s+)?track)/i],
  ['volD', /(?:voladizo\s+(?:delantero|anterior)|front\s+overhang)/i],
  ['volT', /(?:voladizo\s+(?:trasero|posterior)|rear\s+overhang)/i],
  ['masa', /(?:peso\s+en\s+orden\s+de\s+marcha|masa\s+en\s+orden\s+de\s+marcha|peso\s+en\s+vac[ií]o|tara|kerb\s+weight|curb\s+weight)/i],
  ['mma', /(?:m\.?\s?m\.?\s?t?\.?\s?a\.?|masa\s+m[aá]xima|peso\s+m[aá]ximo(?:\s+admisible)?|max(?:imum)?\.?\s+weight|gross\s+weight)/i],
];

/**
 * Extrae medidas y pesos de un texto pegado (fichas de auto-data, km77, ultimatespecs,
 * ficha técnica ITV…). Admite mm, cm o m y kg.
 */
export function parsePastedSpec(text: string): { values: Partial<Record<SpecKey, number>>; tyre: number | null; found: SpecKey[] } {
  const values: Partial<Record<SpecKey, number>> = {};
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    for (const [key, re] of LABELS) {
      if (values[key] !== undefined) continue;
      const m = lines[i].match(re);
      if (!m) continue;
      // número en la misma línea tras la etiqueta, o en la siguiente
      const after = lines[i].slice((m.index ?? 0) + m[0].length);
      const cand = (after.match(/(\d[\d.,]*)\s*(mm|cm|m|kg)?/i) ? after : lines[i + 1] ?? '').match(/(\d[\d.,]*)\s*(?:-\s*(\d[\d.,]*))?\s*(mm|cm|m\b|kg)?/i);
      if (!cand) continue;
      const n = (s: string) => Number(s.replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'));
      let v = n(cand[1]);
      if (cand[2]) v = (v + n(cand[2])) / 2;
      if (!Number.isFinite(v) || v <= 0) continue;
      const unit = (cand[3] ?? '').toLowerCase();
      if (key === 'masa' || key === 'mma') values[key] = v;
      else values[key] = unit === 'mm' || (!unit && v > 50) ? v / 1000 : unit === 'cm' ? v / 100 : v;
    }
  }
  const tyre = tyreDiameter(text);
  return { values, tyre, found: Object.keys(values) as SpecKey[] };
}

export function typeLabel(t: VehicleType) {
  return TYPICAL[t].label;
}
