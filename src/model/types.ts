// Modelo de datos del escenario. Todo en metros y grados.
// Sistema de ejes: X = este, Z = sur (−Z = norte), Y = altura.

export type ID = string;

/** Punto de control de una entidad lineal. `h` = cota absoluta fijada (null = sigue el terreno). */
export interface CtrlPoint {
  x: number;
  z: number;
  h: number | null;
}

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

// ---------- Carreteras ----------

export type LineType =
  | 'ninguna'
  | 'continua'
  | 'discontinua'
  | 'doble_continua'
  | 'mixta_a'
  | 'mixta_b';

export type BandType =
  | 'carril'
  | 'arcen'
  | 'carril_bici'
  | 'aparcamiento'
  | 'acera'
  | 'cuneta'
  | 'tierra'
  | 'hierba';

/** Banda de la sección transversal. `line` = marca vial en su borde exterior. */
export interface Band {
  type: BandType;
  width: number;
  line: LineType;
}

export interface RoadProfile {
  /** Bandas a la izquierda del eje, del eje hacia fuera. */
  left: Band[];
  /** Bandas a la derecha del eje, del eje hacia fuera. */
  right: Band[];
  /** Marca vial en el eje. */
  center: LineType;
  /** Bombeo (%) hacia ambos lados. */
  bombeo: number;
  /** Peralte (%). Positivo = sube hacia la derecha. Si ≠ 0 sustituye al bombeo. */
  peralte: number;
  /** Anchura del talud (terraplén/desmonte) que une la vía con el terreno. */
  talud: number;
  /** Estado del firme: afecta al aspecto. */
  firme: 'nuevo' | 'normal' | 'desgastado';
}

interface EntityBase {
  id: ID;
  name: string;
  hidden?: boolean;
}

export interface RoadEntity extends EntityBase {
  kind: 'road';
  points: CtrlPoint[];
  profile: RoadProfile;
}

export interface RiverEntity extends EntityBase {
  kind: 'river';
  points: CtrlPoint[];
  /** Anchura de la lámina de agua. */
  width: number;
  /** Profundidad del cauce bajo la lámina. */
  depth: number;
  /** Anchura de las orillas que se funden con el terreno. */
  bank: number;
  /** Nivel del agua respecto al terreno original en cada punto sin cota fijada. */
  levelOffset: number;
}

export type LinearType =
  | 'muro'
  | 'valla'
  | 'guardarrail'
  | 'barrera_hormigon'
  | 'seto'
  | 'tendido'
  | 'bordillo';

export interface LinearEntity extends EntityBase {
  kind: 'linear';
  type: LinearType;
  points: CtrlPoint[];
  params: Params;
}

export interface PropEntity extends EntityBase {
  kind: 'prop';
  type: string;
  x: number;
  z: number;
  /** Rotación en grados sobre la vertical. */
  rot: number;
  /** Elevación adicional sobre el terreno. */
  dy: number;
  params: Params;
}

/** Imagen de calco proyectada sobre el terreno (croquis, captura de mapa, ortofoto). */
export interface OverlayEntity extends EntityBase {
  kind: 'overlay';
  asset: ID;
  cx: number;
  cz: number;
  /** Anchura en metros (el alto se deduce del aspecto). */
  width: number;
  /** alto / ancho de la imagen */
  aspect: number;
  rot: number;
  opacity: number;
  /** Si es true se dibuja también encima de carreteras. */
  onRoads: boolean;
}

export type Entity = RoadEntity | RiverEntity | LinearEntity | PropEntity | OverlayEntity;
export type EntityKind = Entity['kind'];
export type SplineEntity = RoadEntity | RiverEntity | LinearEntity;

export interface TerrainData {
  /** Lado del terreno cuadrado (m). */
  size: number;
  /** Divisiones por lado. */
  segs: number;
  /** Alturas base (sin carreteras ni ríos), (segs+1)² valores, fila a fila de norte a sur. */
  base: Float32Array;
}

export interface Environment {
  /** Hora local decimal (0–24). */
  hour: number;
  /** Mes 1–12 (para la posición del sol). */
  month: number;
  wet: boolean;
  fog: number;
}

export interface GeoRef {
  lat: number;
  lon: number;
  /** EPSG del sistema UTM usado (p. ej. 25830). */
  epsg: number;
  /** Coordenadas UTM del origen de la escena. */
  e0: number;
  n0: number;
}

export interface Project {
  version: 1;
  name: string;
  terrain: TerrainData;
  entities: Entity[];
  env: Environment;
  geo: GeoRef | null;
}

export interface Selection {
  id: ID;
  /** Índice del punto de control seleccionado (entidades lineales). */
  point?: number;
}
