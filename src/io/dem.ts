import { fromArrayBuffer } from 'geotiff';
import proj4 from 'proj4';
import type { GeoRef, TerrainData } from '../model/types';
import { toUtm, utmEpsg } from './geo';

/**
 * Elevación real: modelos digitales del terreno del CNIG/IGN (GeoTIFF o ASC),
 * servicio WCS del IGN y, como respaldo fuera de España, teselas globales Terrarium.
 */

export interface Dem {
  width: number;
  height: number;
  data: ArrayLike<number>;
  /** Esquina superior izquierda (borde de píxel) y tamaño de celda, en el SRC del MDT. */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  epsg: number;
  nodata: number | null;
}

/** Cota en coordenadas UTM del proyecto (E, N). NaN si no hay dato. */
export type Sampler = (e: number, n: number) => number;

function crsDef(epsg: number): string {
  if (epsg >= 25828 && epsg <= 25831) return `+proj=utm +zone=${epsg - 25800} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  if (epsg >= 32628 && epsg <= 32631) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg === 23030 || epsg === 23029 || epsg === 23031) return `+proj=utm +zone=${epsg - 23000} +ellps=intl +towgs84=-131,-100.3,-163.4,-1.244,-0.020,-1.144,9.39 +units=m +no_defs`;
  if (epsg === 4258 || epsg === 4326) return '+proj=longlat +ellps=GRS80 +no_defs';
  if (epsg === 3857) return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs';
  throw new Error(`Sistema de referencia EPSG:${epsg} no soportado. Usa ETRS89 UTM (25829/25830/25831) o geográficas (4258).`);
}

export async function parseGeoTiff(buf: ArrayBuffer): Promise<Dem> {
  const tiff = await fromArrayBuffer(buf);
  const img = await tiff.getImage();
  const [minX, , , maxY] = img.getBoundingBox();
  const [rx, ry] = img.getResolution();
  const keys = (img.getGeoKeys() ?? {}) as Record<string, number>;
  const epsg = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey || 25830;
  const rasters = (await img.readRasters({ interleave: true, samples: [0] })) as unknown as ArrayLike<number>;
  const nd = img.getGDALNoData();
  return {
    width: img.getWidth(),
    height: img.getHeight(),
    data: rasters,
    x0: minX,
    y0: maxY,
    dx: Math.abs(rx),
    dy: Math.abs(ry),
    epsg,
    nodata: nd ?? null,
  };
}

/** ESRI ASCII Grid (.asc). El sistema de referencia no va en el archivo: se indica aparte. */
export function parseAsc(text: string, epsg: number): Dem {
  const lines = text.split(/\r?\n/);
  const head: Record<string, number> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].trim().match(/^([a-zA-Z_]+)\s+(-?[\d.eE+-]+)$/);
    if (!m) break;
    head[m[1].toLowerCase()] = Number(m[2]);
  }
  const w = head.ncols;
  const hgt = head.nrows;
  const cs = head.cellsize;
  if (!w || !hgt || !cs) throw new Error('Archivo ASC no válido (faltan ncols/nrows/cellsize).');
  const data = new Float32Array(w * hgt);
  let k = 0;
  for (; i < lines.length && k < data.length; i++) {
    for (const t of lines[i].trim().split(/\s+/)) if (t) data[k++] = Number(t);
  }
  const xll = head.xllcorner ?? (head.xllcenter !== undefined ? head.xllcenter - cs / 2 : 0);
  const yll = head.yllcorner ?? (head.yllcenter !== undefined ? head.yllcenter - cs / 2 : 0);
  return { width: w, height: hgt, data, x0: xll, y0: yll + hgt * cs, dx: cs, dy: cs, epsg, nodata: head.nodata_value ?? null };
}

/** Centro del MDT en latitud/longitud (para georreferenciar una escena vacía). */
export function demCenterLatLon(d: Dem): { lat: number; lon: number } {
  const cx = d.x0 + (d.width * d.dx) / 2;
  const cy = d.y0 - (d.height * d.dy) / 2;
  const [lon, lat] = proj4(crsDef(d.epsg), 'EPSG:4326', [cx, cy]);
  return { lat, lon };
}

export function demSampler(d: Dem, geo: GeoRef): Sampler {
  const same = d.epsg === geo.epsg;
  const conv = same ? null : proj4(crsDef(geo.epsg), crsDef(d.epsg));
  const val = (i: number, j: number) => {
    const v = d.data[j * d.width + i];
    return d.nodata !== null && Math.abs(v - d.nodata) < 1e-3 ? NaN : v;
  };
  return (e, n) => {
    const [x, y] = conv ? conv.forward([e, n]) : [e, n];
    const fx = (x - d.x0) / d.dx - 0.5;
    const fy = (d.y0 - y) / d.dy - 0.5;
    if (fx < 0 || fy < 0 || fx > d.width - 1 || fy > d.height - 1) return NaN;
    const i = Math.min(d.width - 2, Math.floor(fx));
    const j = Math.min(d.height - 2, Math.floor(fy));
    const u = fx - i;
    const v = fy - j;
    return (val(i, j) * (1 - u) + val(i + 1, j) * u) * (1 - v) + (val(i, j + 1) * (1 - u) + val(i + 1, j + 1) * u) * v;
  };
}

/** Georreferencia nueva centrada en (lat, lon). */
export function geoAt(lat: number, lon: number): GeoRef {
  const { e, n, epsg } = toUtm(lat, lon);
  return { lat, lon, epsg, e0: e, n0: n };
}

/**
 * Sustituye el relieve base por el muestreado. Las cotas se guardan relativas a `h0`
 * (la altitud del centro) para trabajar cerca de 0; la barra de estado muestra la real.
 */
export function applyElevation(t: TerrainData, geo: GeoRef, sample: Sampler): { terrain: TerrainData; geo: GeoRef; missing: number } {
  const n = t.segs + 1;
  const half = t.size / 2;
  const step = t.size / t.segs;
  const raw = new Float32Array(n * n);
  let missing = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const v = sample(geo.e0 + (-half + i * step), geo.n0 - (-half + j * step));
      raw[j * n + i] = v;
      if (!Number.isFinite(v)) missing++;
    }
  if (missing === raw.length) throw new Error('El modelo de elevación no cubre la zona de la escena. Comprueba las coordenadas y el sistema de referencia.');
  const c = raw[Math.floor(n / 2) * n + Math.floor(n / 2)];
  let h0 = Number.isFinite(c) ? Math.round(c) : 0;
  if (!Number.isFinite(c)) {
    let s = 0;
    let k = 0;
    for (const v of raw) if (Number.isFinite(v)) ((s += v), k++);
    h0 = Math.round(s / k);
  }
  const base = new Float32Array(n * n);
  for (let k = 0; k < raw.length; k++) base[k] = Number.isFinite(raw[k]) ? raw[k] - h0 : 0;
  return { terrain: { size: t.size, segs: t.segs, base }, geo: { ...geo, h0 }, missing };
}

const isTiff = (b: ArrayBuffer) => {
  const u = new Uint8Array(b, 0, 4);
  return (u[0] === 0x49 && u[1] === 0x49 && u[2] === 42) || (u[0] === 0x4d && u[1] === 0x4d && u[3] === 42);
};

/** Descarga el MDT del IGN para la zona de la escena (prueba varios servicios). */
export async function fetchIgnDem(geo: GeoRef, size: number): Promise<Dem> {
  const m = size / 2 + 20;
  const e1 = (geo.e0 - m).toFixed(1);
  const e2 = (geo.e0 + m).toFixed(1);
  const n1 = (geo.n0 - m).toFixed(1);
  const n2 = (geo.n0 + m).toFixed(1);
  const ep = geo.epsg;
  const urls = [
    `https://servicios.idee.es/wcs-inspire/mdt?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion${ep}_5&SUBSET=x(${e1},${e2})&SUBSET=y(${n1},${n2})&FORMAT=image/tiff`,
    `https://api-coverages.idee.es/collections/EL.ElevationGridCoverage_${ep}_5_PB/coverage?subset=x(${e1}:${e2}),y(${n1}:${n2})&f=GeoTIFF`,
    `https://servicios.idee.es/wcs-inspire/mdt?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCoverage&COVERAGEID=Elevacion${ep}_25&SUBSET=x(${e1},${e2})&SUBSET=y(${n1},${n2})&FORMAT=image/tiff`,
  ];
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const r = await fetch(url, { mode: 'cors' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (!isTiff(buf)) throw new Error('respuesta sin GeoTIFF');
      const d = await parseGeoTiff(buf);
      if (!d.epsg || d.epsg < 1000) d.epsg = ep;
      return d;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(
    `No se pudo descargar el MDT del IGN desde este navegador (${errors.join(' · ')}). ` +
      'Descárgalo del Centro de Descargas del CNIG (centrodedescargas.cnig.es → Modelos Digitales de Elevación → MDT05 o MDT02) e impórtalo con «Importar archivo MDT».',
  );
}

/** Teselas globales Terrarium (AWS Open Data), ≈4–5 m/píxel a zoom 15 en latitudes de España. */
export async function fetchTerrarium(geo: GeoRef, size: number): Promise<Sampler> {
  const z = 15;
  const toLL = proj4(crsDef(geo.epsg), 'EPSG:4326');
  const m = size / 2 + 20;
  const corners = [
    [geo.e0 - m, geo.n0 - m],
    [geo.e0 + m, geo.n0 + m],
  ].map(([e, n]) => toLL.forward([e, n]));
  const tx = (lon: number) => ((lon + 180) / 360) * 2 ** z;
  const ty = (lat: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
  const x0 = Math.floor(tx(corners[0][0]));
  const x1 = Math.floor(tx(corners[1][0]));
  const y0 = Math.floor(ty(corners[1][1]));
  const y1 = Math.floor(ty(corners[0][1]));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 64) throw new Error('Zona demasiado grande para descargar.');
  const tiles = new Map<string, Float32Array>();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  for (let x = x0; x <= x1; x++)
    for (let y = y0; y <= y1; y++) {
      const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
      let res: Response;
      try {
        res = await fetch(url, { mode: 'cors' });
      } catch (err) {
        throw new Error(`No se pudo descargar el relieve global desde este navegador (${(err as Error).message}).`);
      }
      if (!res.ok) throw new Error(`Relieve global: HTTP ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      g.clearRect(0, 0, 256, 256);
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, 256, 256).data;
      const arr = new Float32Array(256 * 256);
      for (let k = 0; k < arr.length; k++) arr[k] = d[k * 4] * 256 + d[k * 4 + 1] + d[k * 4 + 2] / 256 - 32768;
      tiles.set(`${x}/${y}`, arr);
    }
  const px = (gx: number, gy: number) => {
    const X = Math.floor(gx / 256);
    const Y = Math.floor(gy / 256);
    const t = tiles.get(`${X}/${Y}`);
    if (!t) return NaN;
    return t[(gy - Y * 256) * 256 + (gx - X * 256)];
  };
  return (e, n) => {
    const [lon, lat] = toLL.forward([e, n]);
    const gx = tx(lon) * 256 - 0.5;
    const gy = ty(lat) * 256 - 0.5;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const u = gx - i;
    const v = gy - j;
    return (px(i, j) * (1 - u) + px(i + 1, j) * u) * (1 - v) + (px(i, j + 1) * (1 - u) + px(i + 1, j + 1) * u) * v;
  };
}

export { utmEpsg };
