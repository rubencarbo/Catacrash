import { idbGet, idbSet } from '../model/store';
import type { VehicleSpec } from '../model/types';
import type { CatalogRecord } from './spec';

/** Catálogo de modelos reales (public/data/vehiculos.json), cargado bajo demanda. */
let catalog: CatalogRecord[] | null = null;
let loading: Promise<CatalogRecord[]> | null = null;

export function loadCatalog(): Promise<CatalogRecord[]> {
  if (catalog) return Promise.resolve(catalog);
  if (!loading) {
    loading = fetch('data/vehiculos.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<CatalogRecord[]>;
      })
      .then((d) => (catalog = d))
      .catch((e) => {
        loading = null;
        throw new Error(`No se pudo cargar el catálogo de vehículos (${(e as Error).message}).`);
      });
  }
  return loading;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ');

/** Búsqueda por palabras («seat leon 2015», «golf vii variant»…). Un año filtra por fechas de producción. */
export function searchCatalog(list: CatalogRecord[], query: string, limit = 60): CatalogRecord[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const year = words.map(Number).find((n) => n >= 1950 && n <= 2100);
  const terms = words.filter((w) => !(Number(w) >= 1950 && Number(w) <= 2100));
  const out: { r: CatalogRecord; score: number }[] = [];
  for (const r of list) {
    if (year && ((r.desde ?? 0) > year || (r.hasta ?? 9999) < year)) continue;
    const hay = norm(`${r.marca} ${r.modelo} ${r.generacion} ${r.carroceria ?? r.tipo ?? ''}`);
    let ok = true;
    let score = 0;
    const hayWords = hay.split(/\s+/);
    for (const t of terms) {
      // Números romanos de generación (ii, vii…) y números cortos: palabra exacta
      const exact = /^[ivx]+$/.test(t) || /^\d{1,3}$/.test(t);
      const w = hayWords.findIndex((hw) => (exact ? hw === t : hw.startsWith(t)));
      if (w < 0) {
        if (exact || !hay.includes(t)) {
          ok = false;
          break;
        }
        score += 1;
      } else score += hayWords[w] === t ? 3 : 2;
    }
    if (ok) out.push({ r, score: score + (r.desde ?? 0) / 10000 });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit).map((x) => x.r);
}

// ---------- Biblioteca personal ----------

export interface SavedVehicle {
  name: string;
  spec: VehicleSpec;
  savedAt: number;
}

const KEY = 'vehiculos-propios';

export async function loadLibrary(): Promise<SavedVehicle[]> {
  return (await idbGet<SavedVehicle[]>(KEY)) ?? [];
}

export async function saveToLibrary(name: string, spec: VehicleSpec) {
  const lib = await loadLibrary();
  const i = lib.findIndex((v) => v.name === name);
  const item = { name, spec: structuredClone(spec), savedAt: Date.now() };
  if (i >= 0) lib[i] = item;
  else lib.unshift(item);
  await idbSet(KEY, lib);
}

export async function removeFromLibrary(name: string) {
  const lib = (await loadLibrary()).filter((v) => v.name !== name);
  await idbSet(KEY, lib);
}
