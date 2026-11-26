import type { Band, RoadProfile } from '../model/types';

export const CURB_HEIGHT = 0.15;

export interface BandLayout {
  band: Band;
  side: -1 | 1;
  /** Distancia firmada al eje del borde interior y exterior (|oIn| < |oOut|). */
  oIn: number;
  oOut: number;
  /** Cota relativa al eje en un desplazamiento lateral o dentro de la banda. */
  h: (o: number) => number;
  /** Cota en el borde exterior de la banda anterior (para detectar bordillos/escalones). */
  prevOut: number;
}

export interface ProfileLayout {
  bands: BandLayout[];
  halfL: number;
  halfR: number;
  /** Cota relativa al eje en cualquier desplazamiento lateral (se prolonga fuera de la vía). */
  heightAt: (o: number) => number;
}

const isPaved = (t: Band['type']) =>
  t === 'carril' || t === 'arcen' || t === 'carril_bici' || t === 'aparcamiento';

export function cross(p: RoadProfile, o: number) {
  return p.peralte !== 0 ? (o * p.peralte) / 100 : (-Math.abs(o) * p.bombeo) / 100;
}

export function layoutProfile(p: RoadProfile): ProfileLayout {
  const bands: BandLayout[] = [];
  const halves: Record<string, number> = { '-1': 0, '1': 0 };
  for (const side of [-1, 1] as const) {
    const list = side < 0 ? p.left : p.right;
    let o = 0;
    let prevOut = cross(p, 0);
    let prevType: Band['type'] | null = null;
    for (const band of list) {
      const w = Math.max(0.05, band.width);
      const oIn = o * side;
      const oOut = (o + w) * side;
      const start = prevOut;
      let h: (o: number) => number;
      if (isPaved(band.type)) {
        h = (x) => cross(p, x);
      } else if (band.type === 'acera') {
        const top = prevType === 'acera' ? start : cross(p, oIn) + CURB_HEIGHT;
        h = () => top;
      } else if (band.type === 'cuneta') {
        const depth = Math.min(0.5, w * 0.35);
        h = (x) => {
          const t = (Math.abs(x) - Math.abs(oIn)) / w;
          return start - depth * (1 - Math.abs(2 * t - 1));
        };
      } else {
        const c0 = cross(p, oIn);
        h = (x) => start + (cross(p, x) - c0) - 0.02 * Math.min(1, (Math.abs(x) - Math.abs(oIn)) / 0.3);
      }
      bands.push({ band, side, oIn, oOut, h, prevOut: start });
      prevOut = h(oOut);
      prevType = band.type;
      o += w;
    }
    halves[side] = o;
  }

  const heightAt = (o: number) => {
    const side = o < 0 ? -1 : 1;
    const a = Math.abs(o);
    let last: BandLayout | null = null;
    for (const b of bands) {
      if (b.side !== side) continue;
      last = b;
      if (a >= Math.abs(b.oIn) && a <= Math.abs(b.oOut)) return b.h(o);
    }
    return last ? last.h(last.oOut) : cross(p, 0);
  };

  return { bands, halfL: halves['-1'], halfR: halves['1'], heightAt };
}
