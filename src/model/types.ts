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
  /** Jerarquía en cruces: 0 secundaria, 1 normal, 2 principal. La de mayor rango manda en el solape. */
  priority?: number;
}

export type AreaMaterial = 'asfalto' | 'hormigon' | 'adoquin' | 'acera' | 'tierra' | 'grava' | 'hierba' | 'cebreado';

/** Superficie poligonal: ensanches de cruces, isletas, explanadas, aparcamientos, plazas… */
export interface AreaEntity extends EntityBase {
  kind: 'area';
  points: CtrlPoint[];
  material: AreaMaterial;
  /** Altura sobre la rasante (0 = enrasada; >0 = isleta con bordillo). */
  raise: number;
  talud: number;
  /** Orientación de las franjas del cebreado (grados). */
  angle: number;
}

/** Glorieta paramétrica. */
export interface RoundaboutEntity extends EntityBase {
  kind: 'roundabout';
  cx: number;
  cz: number;
  /** Cota fija del centro (null = terreno). */
  h: number | null;
  /** Radio exterior de la calzada anular. */
  radius: number;
  /** Ancho de la calzada anular. */
  width: number;
  lanes: number;
  /** Gorjal (anillo montable junto a la isleta). */
  apron: number;
  island: 'hierba' | 'pavimento' | 'tierra';
  outer: 'ninguno' | 'arcen' | 'acera';
  outerWidth: number;
  talud: number;
}

/** Foto de referencia situada en la escena (360°, panorámica de móvil o foto normal). */
export interface PhotoEntity extends EntityBase {
  kind: 'photo';
  asset: ID;
  x: number;
  z: number;
  /** Altura de la cámara sobre el suelo. */
  height: number;
  /** Rumbo del centro de la imagen (grados desde el norte, sentido horario). */
  heading: number;
  pitch: number;
  roll: number;
  mode: 'esferica' | 'cilindrica' | 'plana';
  /** Campo de visión horizontal (cilíndrica y plana). */
  hfov: number;
  /** alto / ancho */
  aspect: number;
  opacity: number;
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

// ---------- Vehículos ----------

export type VehicleType =
  | 'urbano'
  | 'compacto'
  | 'berlina'
  | 'familiar'
  | 'coupe'
  | 'suv'
  | 'suv_grande'
  | 'monovolumen'
  | 'todoterreno'
  | 'pickup'
  | 'furgoneta'
  | 'furgon'
  | 'camion'
  | 'tractora'
  | 'autobus'
  | 'moto'
  | 'ciclomotor'
  | 'bicicleta'
  | 'patinete'
  | 'peaton';

/** Origen de cada dato de la ficha. */
export type SpecSource = 'catalogo' | 'ficha' | 'estimado' | 'generico';

/** Ficha del vehículo. Longitudes en metros, masas en kg. */
export interface VehicleSpec {
  tipo: VehicleType;
  marca: string;
  modelo: string;
  version: string;
  anio: number | null;
  L: number;
  W: number;
  H: number;
  batalla: number;
  viaD: number;
  viaT: number;
  volD: number;
  volT: number;
  /** Masa en orden de marcha (incluye 75 kg de conductor según la norma UE). */
  masa: number;
  mma: number | null;
  /** Diámetro exterior de la rueda. */
  rueda: number;
  traccion: 'delantera' | 'trasera' | 'total';
  /** Altura del centro de gravedad sobre el suelo. */
  cdgAltura: number;
  /** Distancia del centro de gravedad al eje delantero. */
  cdgEje: number;
  /** Momento de inercia de guiñada (kg·m²). */
  inercia: number;
  /** De dónde sale cada dato (los que faltan se consideran estimados). */
  origen: Partial<Record<SpecKey, SpecSource>>;
  url?: string;
}

export type SpecKey = 'L' | 'W' | 'H' | 'batalla' | 'viaD' | 'viaT' | 'volD' | 'volT' | 'masa' | 'mma' | 'rueda' | 'cdgAltura' | 'cdgEje' | 'inercia';

export type DamageSide = 'frontal' | 'trasera' | 'izquierda' | 'derecha' | 'techo';

/** Zona dañada: tramo de un lado del vehículo (0–1 de izquierda a derecha o de delante atrás). */
export interface DamageZone {
  id: ID;
  side: DamageSide;
  from: number;
  to: number;
  /** Profundidad máxima del aplastamiento (m). */
  depth: number;
  /** Banda de altura afectada (fracción de la altura del vehículo). */
  hFrom: number;
  hTo: number;
  note: string;
}

export interface VehicleEntity extends EntityBase {
  kind: 'vehicle';
  /** Etiqueta corta que se muestra sobre el vehículo (A, B, V1…). */
  label: string;
  spec: VehicleSpec;
  x: number;
  z: number;
  /** Rumbo en grados desde el norte, sentido horario (hacia donde mira el frontal). */
  heading: number;
  color: string;
  plate: string;
  occupants: number;
  cargo: number;
  damage: DamageZone[];
  /** Fotos del vehículo (ids de imágenes guardadas). */
  photos: ID[];
}

export type Entity =
  | RoadEntity
  | RiverEntity
  | LinearEntity
  | PropEntity
  | OverlayEntity
  | AreaEntity
  | RoundaboutEntity
  | PhotoEntity
  | VehicleEntity;
export type EntityKind = Entity['kind'];
export type SplineEntity = RoadEntity | RiverEntity | LinearEntity | AreaEntity;

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
  /** Altitud real que corresponde a la cota 0 de la escena (si se importó elevación). */
  h0?: number;
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
