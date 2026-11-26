import type {
  Band,
  BandType,
  LineType,
  LinearType,
  Params,
  Project,
  RoadProfile,
  TerrainData,
} from './types';

export const BAND_LABELS: Record<BandType, string> = {
  carril: 'Carril',
  arcen: 'Arcén',
  carril_bici: 'Carril bici',
  aparcamiento: 'Aparcamiento',
  acera: 'Acera (con bordillo)',
  cuneta: 'Cuneta',
  tierra: 'Tierra / grava',
  hierba: 'Hierba',
};

export const BAND_DEFAULT_WIDTH: Record<BandType, number> = {
  carril: 3.5,
  arcen: 1.0,
  carril_bici: 1.5,
  aparcamiento: 2.2,
  acera: 2.0,
  cuneta: 1.2,
  tierra: 1.5,
  hierba: 1.5,
};

export const LINE_LABELS: Record<LineType, string> = {
  ninguna: 'Sin marca',
  continua: 'Continua',
  discontinua: 'Discontinua',
  doble_continua: 'Doble continua',
  mixta_a: 'Continua + discontinua',
  mixta_b: 'Discontinua + continua',
};

const b = (type: BandType, width = BAND_DEFAULT_WIDTH[type], line: LineType = 'ninguna'): Band => ({
  type,
  width,
  line,
});

export interface RoadPreset {
  label: string;
  make: () => RoadProfile;
}

const base = { bombeo: 2, peralte: 0, talud: 4, firme: 'normal' as const };

export const ROAD_PRESETS: Record<string, RoadPreset> = {
  convencional: {
    label: 'Convencional 1+1 con arcén',
    make: () => ({
      ...base,
      center: 'discontinua',
      left: [b('carril', 3.5, 'continua'), b('arcen', 1.0)],
      right: [b('carril', 3.5, 'continua'), b('arcen', 1.0)],
    }),
  },
  convencional_cuneta: {
    label: 'Convencional 1+1 con arcén y cunetas',
    make: () => ({
      ...base,
      center: 'continua',
      left: [b('carril', 3.5, 'continua'), b('arcen', 1.0), b('cuneta', 1.2)],
      right: [b('carril', 3.5, 'continua'), b('arcen', 1.0), b('cuneta', 1.2)],
    }),
  },
  secundaria: {
    label: 'Secundaria estrecha sin arcén',
    make: () => ({
      ...base,
      center: 'discontinua',
      talud: 3,
      left: [b('carril', 3.0, 'continua'), b('tierra', 0.6)],
      right: [b('carril', 3.0, 'continua'), b('tierra', 0.6)],
    }),
  },
  urbana: {
    label: 'Calle urbana con aparcamiento y aceras',
    make: () => ({
      ...base,
      center: 'discontinua',
      talud: 2,
      left: [b('carril', 3.25), b('aparcamiento', 2.2), b('acera', 2.5)],
      right: [b('carril', 3.25), b('aparcamiento', 2.2), b('acera', 2.5)],
    }),
  },
  calle_estrecha: {
    label: 'Calle estrecha con aceras',
    make: () => ({
      ...base,
      center: 'ninguna',
      talud: 2,
      left: [b('carril', 3.0), b('acera', 1.5)],
      right: [b('carril', 3.0), b('acera', 1.5)],
    }),
  },
  calzada_2_carriles: {
    label: 'Calzada de 2 carriles (un sentido)',
    make: () => ({
      ...base,
      center: 'continua',
      left: [b('arcen', 1.0)],
      right: [b('carril', 3.5, 'discontinua'), b('carril', 3.5, 'continua'), b('arcen', 2.5)],
    }),
  },
  camino: {
    label: 'Camino de tierra',
    make: () => ({
      ...base,
      center: 'ninguna',
      bombeo: 3,
      talud: 2,
      firme: 'desgastado',
      left: [b('tierra', 2.0)],
      right: [b('tierra', 2.0)],
    }),
  },
};

// ---------- Elementos lineales ----------

export interface LinearDef {
  label: string;
  defaults: Params;
}

export const LINEAR_DEFS: Record<LinearType, LinearDef> = {
  muro: {
    label: 'Muro',
    defaults: { altura: 1.5, grosor: 0.4, material: 'hormigon', curva: false },
  },
  valla: {
    label: 'Valla',
    defaults: { altura: 1.5, tipo: 'malla', separacion: 2.5, curva: false },
  },
  guardarrail: {
    label: 'Guardarraíl (bionda)',
    defaults: { altura: 0.75, separacion: 4, lado: 'izquierda', curva: true },
  },
  barrera_hormigon: {
    label: 'Barrera de hormigón (New Jersey)',
    defaults: { curva: true },
  },
  seto: {
    label: 'Seto',
    defaults: { altura: 1.2, ancho: 0.8, curva: true },
  },
  tendido: {
    label: 'Tendido eléctrico / telefónico',
    defaults: { altura: 9, poste: 'madera', cables: 3, flecha: 0.8, separacion: 0.6 },
  },
  bordillo: {
    label: 'Bordillo suelto',
    defaults: { altura: 0.15, ancho: 0.15, curva: true },
  },
};

// ---------- Remuestreo del terreno ----------

/** Cambia tamaño y resolución del terreno conservando el relieve (bilineal; fuera del área anterior se prolonga el borde). */
export function resampleTerrain(t: TerrainData, size: number, step: number): TerrainData {
  const segs = Math.max(10, Math.round(size / step));
  const n = segs + 1;
  const base = new Float32Array(n * n);
  const on = t.segs + 1;
  const ohalf = t.size / 2;
  const ostep = t.size / t.segs;
  const sample = (x: number, z: number) => {
    const fx = Math.max(0, Math.min(t.segs - 1e-6, (x + ohalf) / ostep));
    const fz = Math.max(0, Math.min(t.segs - 1e-6, (z + ohalf) / ostep));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const a = t.base[j * on + i];
    const b = t.base[j * on + i + 1];
    const c = t.base[(j + 1) * on + i];
    const d = t.base[(j + 1) * on + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
  const half = size / 2;
  const st = size / segs;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) base[j * n + i] = sample(-half + i * st, -half + j * st);
  return { size, segs, base };
}

// ---------- Proyecto vacío ----------

export const TERRAIN_SIZE = 300;
export const TERRAIN_SEGS = 300;

export function emptyProject(): Project {
  const n = TERRAIN_SEGS + 1;
  return {
    version: 2,
    name: 'Escenario sin título',
    terrain: { size: TERRAIN_SIZE, segs: TERRAIN_SEGS, base: new Float32Array(n * n) },
    entities: [],
    env: { hour: 12, month: 6, wet: false, fog: 0 },
    geo: null,
  };
}

// ---------- Campos editables de los elementos lineales ----------
import { bool as fBool, num as fNum, sel as fSel, type FieldDef } from './fields';

export const LINEAR_FIELDS: Record<LinearType, FieldDef[]> = {
  muro: [
    fNum('altura', 'Altura', 'm', 0.1, 20),
    fNum('grosor', 'Grosor', 'm', 0.05, 3, 0.01),
    fSel('material', 'Material', [
      ['hormigon', 'Hormigón'],
      ['piedra', 'Mampostería (piedra)'],
      ['ladrillo', 'Ladrillo'],
      ['bloque', 'Bloque de hormigón'],
    ]),
    fBool('curva', 'Trazado curvo'),
  ],
  valla: [
    fNum('altura', 'Altura', 'm', 0.3, 6),
    fSel('tipo', 'Tipo', [
      ['malla', 'Malla metálica'],
      ['metalica', 'Barrotes metálicos'],
      ['madera', 'Madera'],
    ]),
    fNum('separacion', 'Separación postes', 'm', 0.5, 10),
    fBool('curva', 'Trazado curvo'),
  ],
  guardarrail: [
    fNum('altura', 'Altura', 'm', 0.4, 1.5, 0.01),
    fNum('separacion', 'Separación postes', 'm', 1, 8, 0.1),
    fSel('lado', 'Bionda hacia', [
      ['izquierda', 'Izquierda del trazado'],
      ['derecha', 'Derecha del trazado'],
    ]),
    fBool('curva', 'Trazado curvo'),
  ],
  barrera_hormigon: [fBool('curva', 'Trazado curvo')],
  seto: [fNum('altura', 'Altura', 'm', 0.2, 6), fNum('ancho', 'Ancho', 'm', 0.2, 4), fBool('curva', 'Trazado curvo')],
  tendido: [
    fNum('altura', 'Altura postes', 'm', 3, 30, 0.1),
    fSel('poste', 'Poste', [
      ['madera', 'Madera'],
      ['hormigon', 'Hormigón'],
      ['metalico', 'Metálico'],
    ]),
    fNum('cables', 'Nº de cables', '', 1, 6, 1),
    fNum('flecha', 'Flecha (catenaria)', 'm', 0, 5),
    fNum('separacion', 'Separación cables', 'm', 0.1, 2),
  ],
  bordillo: [fNum('altura', 'Altura', 'm', 0.05, 0.5, 0.01), fNum('ancho', 'Ancho', 'm', 0.05, 0.6, 0.01), fBool('curva', 'Trazado curvo')],
};
