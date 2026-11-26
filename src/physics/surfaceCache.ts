import type { SurfaceKind } from './sim';

/**
 * Caché de consultas al suelo para la simulación. La altura se guarda en una malla de nodos
 * (interpolación bilineal) y el tipo de firme por celdas; ambas se rellenan bajo demanda y se
 * reutilizan entre simulaciones hasta que cambia el escenario. Así cada paso de 1 ms no tiene
 * que recorrer calzadas, áreas y terreno.
 */
export class SurfaceCache {
  private hNodes = new Map<number, number>();
  private kCells = new Map<number, SurfaceKind>();

  constructor(
    private fh: (x: number, z: number) => number,
    private fk: (x: number, z: number) => SurfaceKind,
    private hCell = 0.5,
    private kCell = 0.25,
  ) {}

  private static key(i: number, j: number) {
    return (i + 1_000_000) * 2_000_003 + (j + 1_000_000);
  }

  private node(i: number, j: number) {
    const k = SurfaceCache.key(i, j);
    let v = this.hNodes.get(k);
    if (v === undefined) {
      v = this.fh(i * this.hCell, j * this.hCell);
      this.hNodes.set(k, v);
    }
    return v;
  }

  height = (x: number, z: number): number => {
    const u = x / this.hCell;
    const w = z / this.hCell;
    const i = Math.floor(u);
    const j = Math.floor(w);
    const fu = u - i;
    const fw = w - j;
    const a = this.node(i, j);
    const b = this.node(i + 1, j);
    const c = this.node(i, j + 1);
    const d = this.node(i + 1, j + 1);
    return (a * (1 - fu) + b * fu) * (1 - fw) + (c * (1 - fu) + d * fu) * fw;
  };

  kind = (x: number, z: number): SurfaceKind => {
    const i = Math.floor(x / this.kCell);
    const j = Math.floor(z / this.kCell);
    const k = SurfaceCache.key(i, j);
    let v = this.kCells.get(k);
    if (v === undefined) {
      v = this.fk((i + 0.5) * this.kCell, (j + 0.5) * this.kCell);
      this.kCells.set(k, v);
    }
    return v;
  };

  get size() {
    return this.hNodes.size + this.kCells.size;
  }
}
