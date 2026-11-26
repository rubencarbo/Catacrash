import type { Editor } from '../editor';
import { applyElevation, demCenterLatLon, demSampler, fetchIgnDem, fetchTerrarium, geoAt, parseAsc, parseGeoTiff, type Sampler } from '../io/dem';
import type { GeoRef } from '../model/types';
import { h, toast } from '../ui/dom';

/** Desplaza las cotas fijadas a mano cuando cambia la altitud de referencia. */
function shiftFixedHeights(ed: Editor, dh: number) {
  if (Math.abs(dh) < 1e-6) return;
  for (const e of ed.store.project.entities) {
    if ('points' in e) for (const p of e.points) if (p.h !== null) p.h += dh;
    if (e.kind === 'roundabout' && e.h !== null) e.h += dh;
  }
}

function apply(ed: Editor, geo: GeoRef, sample: Sampler, source: string) {
  const p = ed.store.project;
  const { terrain, geo: g2, missing } = applyElevation(p.terrain, geo, sample);
  const oldH0 = p.geo?.h0 ?? g2.h0 ?? 0;
  ed.store.edit(() => {
    p.terrain = terrain;
    p.geo = g2;
    shiftFixedHeights(ed, oldH0 - (g2.h0 ?? 0));
  }, { type: 'all' });
  const pct = Math.round((missing / terrain.base.length) * 100);
  toast(`Relieve real aplicado (${source}). Cota de referencia: ${g2.h0} m.${pct ? ` ${pct} % de la escena sin datos (queda a cota 0).` : ''}`, 'info', 6000);
}

/** Sección «Relieve real» del panel de terreno. */
export function renderElevation(el: HTMLElement, ed: Editor) {
  const geo = ed.store.project.geo;
  const pos = { lat: geo?.lat ?? 40.4168, lon: geo?.lon ?? -3.7038 };
  let ascEpsg = geo?.epsg ?? 25830;

  el.append(h('div', { class: 'cat-title' }, 'Relieve real'));
  if (geo) el.append(h('p', { class: 'muted' }, `Escena georreferenciada en ${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)} (UTM ${geo.epsg - 25800}N).`));
  else {
    const coords = h('input', {
      type: 'text',
      placeholder: 'Coordenadas del centro: 40.4168, -3.7038',
      onchange: (e: Event) => {
        const m = (e.target as HTMLInputElement).value.match(/(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/);
        if (m) {
          pos.lat = Number(m[1].replace(',', '.'));
          pos.lon = Number(m[2].replace(',', '.'));
        }
      },
    });
    el.append(h('label', { class: 'field wide' }, coords));
  }
  const currentGeo = () => ed.store.project.geo ?? geoAt(pos.lat, pos.lon);
  const busy = async (label: string, fn: () => Promise<void>) => {
    toast(label);
    try {
      await fn();
    } catch (err) {
      toast((err as Error).message, 'error', 12000);
    }
  };

  const file = h('input', {
    type: 'file',
    accept: '.tif,.tiff,.asc,.txt',
    style: 'display:none',
    onchange: async (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      await busy('Leyendo el modelo de elevación…', async () => {
        const dem = /\.(tif|tiff)$/i.test(f.name) ? await parseGeoTiff(await f.arrayBuffer()) : parseAsc(await f.text(), ascEpsg);
        let g = ed.store.project.geo;
        if (!g) {
          const c = demCenterLatLon(dem);
          g = geoAt(c.lat, c.lon);
        }
        apply(ed, g, demSampler(dem, g), f.name);
      });
    },
  });
  const epsgSel = h('select', { onchange: (e: Event) => (ascEpsg = Number((e.target as HTMLSelectElement).value)) });
  for (const [v, l] of [
    [25829, 'ETRS89 UTM 29N'],
    [25830, 'ETRS89 UTM 30N'],
    [25831, 'ETRS89 UTM 31N'],
    [4258, 'ETRS89 geográficas'],
  ] as [number, string][])
    epsgSel.append(h('option', { value: v, selected: v === ascEpsg }, l));

  el.append(
    h(
      'div',
      { class: 'row wrap' },
      h('button', { class: 'btn primary', onclick: () => busy('Descargando MDT del IGN…', async () => {
        const g = currentGeo();
        const dem = await fetchIgnDem(g, ed.store.project.terrain.size);
        apply(ed, g, demSampler(dem, g), 'MDT IGN');
      }) }, 'Descargar MDT del IGN'),
      h('button', { class: 'btn', onclick: () => busy('Descargando relieve global…', async () => {
        const g = currentGeo();
        apply(ed, g, await fetchTerrarium(g, ed.store.project.terrain.size), 'relieve global');
      }) }, 'Relieve global'),
    ),
    file,
    h('button', { class: 'btn', onclick: () => file.click() }, 'Importar archivo MDT (.tif, .asc)…'),
    h('label', { class: 'field' }, h('span', {}, 'SRC de archivos .asc'), epsgSel),
    h(
      'p',
      { class: 'muted' },
      'El MDT del IGN (2–5 m) es la mejor fuente en España: si la descarga directa falla, bájalo del Centro de Descargas del CNIG e impórtalo. El relieve global (≈5 m) sirve para cualquier país. Después puedes retocarlo con el pincel.',
    ),
  );
}
