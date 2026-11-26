import proj4 from 'proj4';
import type { GeoRef } from '../model/types';

/** UTM ETRS89 (EPSG:258zz) para una longitud dada. */
export function utmEpsg(lon: number) {
  const zone = Math.max(28, Math.min(31, Math.floor((lon + 180) / 6) + 1));
  return { zone, epsg: 25800 + zone };
}

function utmDef(zone: number) {
  return `+proj=utm +zone=${zone} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
}

export function toUtm(lat: number, lon: number) {
  const { zone, epsg } = utmEpsg(lon);
  const [e, n] = proj4('EPSG:4326', utmDef(zone), [lon, lat]);
  return { e, n, zone, epsg };
}

/** Coordenadas UTM de un punto de la escena (x = este, z = sur). */
export function sceneToUtm(geo: GeoRef, x: number, z: number) {
  return { e: geo.e0 + x, n: geo.n0 - z };
}

/** URL GetMap del WMS de ortofoto PNOA del IGN para un cuadrado centrado en (lat, lon). */
export function pnoaUrl(lat: number, lon: number, size: number, px = 2048) {
  const { e, n, epsg } = toUtm(lat, lon);
  const h = size / 2;
  const bbox = [e - h, n - h, e + h, n + h].map((v) => v.toFixed(2)).join(',');
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: 'OI.OrthoimageCoverage',
    STYLES: '',
    CRS: `EPSG:${epsg}`,
    BBOX: bbox,
    WIDTH: String(px),
    HEIGHT: String(px),
    FORMAT: 'image/jpeg',
  });
  return { url: `https://www.ign.es/wms-inspire/pnoa-ma?${q}`, e, n, epsg };
}

/**
 * Descarga la ortofoto y la devuelve como dataURL (necesario para guardarla en el proyecto).
 * Requiere que el servicio permita CORS; si no, se indica cómo cargarla a mano.
 */
export async function loadPnoa(lat: number, lon: number, size: number): Promise<{ url: string; geo: GeoRef }> {
  const px = Math.min(4096, Math.max(512, Math.round(size / 0.15)));
  const { url, e, n, epsg } = pnoaUrl(lat, lon, size, px);
  const geo: GeoRef = { lat, lon, epsg, e0: e, n0: n };
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('respuesta no válida');
    const data = await new Promise<string>((ok, ko) => {
      const r = new FileReader();
      r.onload = () => ok(r.result as string);
      r.onerror = () => ko(r.error);
      r.readAsDataURL(blob);
    });
    return { url: data, geo };
  } catch (err) {
    throw new Error(
      `No se pudo descargar la ortofoto desde este navegador (${(err as Error).message}). ` +
        `Ábrela en otra pestaña, guárdala y cárgala con «Cargar imagen» (desactiva fondo transparente y pon ${size} m de ancho): ${url}`,
    );
  }
}
