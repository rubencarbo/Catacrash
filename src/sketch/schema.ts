/**
 * Lo que la IA devuelve al leer un croquis: coordenadas en píxeles de la imagen enviada
 * (origen arriba a la izquierda, y hacia abajo) y rumbos en grados en sentido horario desde
 * «arriba» de la imagen.
 */
export type XY = [number, number];

export type SketchRole = 'ini' | 'col' | 'fin' | 'mid';

export interface SketchPosition {
  /** Rótulo tal como aparece (A1, A2, B3, PF…). */
  tag: string;
  role: SketchRole;
  center: XY;
  /** Hacia dónde mira el frontal (0 = arriba de la imagen, 90 = derecha). */
  heading_deg: number;
  length_px?: number | null;
  width_px?: number | null;
  /** 0–1 */
  confidence?: number;
}

export interface SketchVehicle {
  label: string;
  type: string;
  description?: string;
  positions: SketchPosition[];
}

export interface SketchRoad {
  name?: string | null;
  kind?: 'convencional' | 'secundaria' | 'urbana' | 'camino' | 'autovia' | string;
  /** Eje de la calzada, de un extremo al otro del dibujo. */
  centerline: XY[];
  /** Anchura de la calzada dibujada (de borde a borde), en píxeles. */
  width_px: number;
  lanes?: number;
  main?: boolean;
  /** Sentido(s) indicados en el dibujo (texto libre). */
  direction_note?: string | null;
}

export interface SketchSign {
  type: 'stop' | 'ceda' | 'semaforo' | 'velocidad' | 'paso_peatones' | 'prohibido' | 'otro' | string;
  value?: string | null;
  position: XY;
  /** Rumbo de la marcha del tráfico al que va dirigida (0 = hacia arriba de la imagen). */
  traffic_heading_deg?: number | null;
}

export interface SketchMarking {
  type: 'linea_detencion' | 'paso_peatones' | 'linea_continua' | 'flecha' | 'otro' | string;
  position: XY;
  heading_deg?: number | null;
  length_px?: number | null;
}

export interface SketchObject {
  type: string;
  position: XY;
  label?: string | null;
}

export interface SketchText {
  text: string;
  position?: XY | null;
  meaning?: 'road_name' | 'direction' | 'pk' | 'cause' | 'legend' | 'note' | 'scale' | 'other' | string;
}

export interface SketchResult {
  image_size?: { width: number; height: number };
  /** Dirección del norte en la imagen (grados horarios desde arriba) si hay flecha de norte. */
  north_deg?: number | null;
  /** Metros por píxel si el croquis tiene cotas o escala escritas. */
  meters_per_px?: number | null;
  scale_evidence?: string | null;
  roads: SketchRoad[];
  vehicles: SketchVehicle[];
  impact?: XY | null;
  signs?: SketchSign[];
  markings?: SketchMarking[];
  objects?: SketchObject[];
  texts?: SketchText[];
  summary?: string;
  uncertainties?: string[];
}

export function sketchPrompt(w: number, h: number) {
  return `Eres un experto en reconstrucción de accidentes de tráfico. La imagen adjunta es un CROQUIS de un accidente (normalmente dibujado a mano por la policía o por un implicado; puede ser una foto del papel, torcida o con sombras). Mide ${w} × ${h} píxeles. Léelo con atención e interpreta TODOS sus elementos para reconstruir la escena en planta.

Convenciones de coordenadas (obligatorias):
- Coordenadas en PÍXELES de esta imagen de ${w}×${h}: x de 0 (izquierda) a ${w} (derecha), y de 0 (arriba) a ${h} (abajo).
- Rumbos en grados, en sentido horario desde «arriba» de la imagen: 0 = hacia arriba, 90 = hacia la derecha, 180 = hacia abajo, 270 = hacia la izquierda.

Cómo se leen los croquis de atestados:
- Cada vehículo es un rectángulo (o silueta) con su letra (A, B, C… o 1, 2…). El frontal suele marcarse con una flecha, un triángulo, una cuña o un pico en un extremo; si no, deduce el frontal por el sentido de la marcha (flechas de trayectoria, carril por el que circula, sentido de la vía).
- Los números tras la letra indican el momento: A1 = posición inicial (cuando surge el peligro), A2 = posición en el instante del choque, A3 = posición final de reposo. Si solo hay dos, la última es la final. «PF» o «P.F.» = posición final (role "fin"). Posiciones intermedias sin número claro → role "mid".
- «PC», «P.C.», una estrella, una X o un aspa = punto de colisión → "impact". Si no aparece, estima el punto donde se tocan las posiciones de choque.
- Las líneas paralelas largas son los bordes de las calzadas; las discontinuas, separación de carriles. En un cruce, la vía que continúa es la principal ("main": true).
- Señales: «STOP», octógono, triángulo invertido (ceda el paso), círculos con número (velocidad), semáforos. Indica a qué tráfico va dirigida con el rumbo de la marcha de ese tráfico.
- Textos: nombre de la vía (p. ej. «C-31», «N-340», «Calle Mayor»), punto kilométrico («p.k. 147,2»), sentidos («sentido Barcelona», «sentit Cubelles»), leyendas, causa («causa directa…»), cotas o medidas («7 m»).

Devuelve SOLO un objeto JSON (sin texto alrededor) con esta forma:
{
  "image_size": {"width": ${w}, "height": ${h}},
  "north_deg": número o null (dirección del norte si hay flecha de norte),
  "meters_per_px": número o null (solo si hay cotas o escala escritas que lo permitan calcular),
  "scale_evidence": texto o null (qué medida usaste),
  "roads": [{"name": texto o null, "kind": "convencional"|"secundaria"|"urbana"|"camino"|"autovia", "centerline": [[x,y], …] (eje de la calzada, de extremo a extremo del dibujo, con suficientes puntos para seguir curvas; en un cruce en T la vía secundaria termina en el eje de la principal), "width_px": anchura de borde a borde de la calzada, "lanes": número total de carriles, "main": true|false, "direction_note": texto o null}],
  "vehicles": [{"label": "A", "type": "turismo"|"furgoneta"|"camion"|"autobus"|"moto"|"ciclomotor"|"bicicleta"|"peaton"|"suv", "description": texto breve, "positions": [{"tag": "A1", "role": "ini"|"col"|"fin"|"mid", "center": [x,y] (centro del rectángulo), "heading_deg": rumbo del frontal, "length_px": número, "width_px": número, "confidence": 0–1}]}],
  "impact": [x,y] o null,
  "signs": [{"type": "stop"|"ceda"|"semaforo"|"velocidad"|"paso_peatones"|"prohibido"|"otro", "value": texto o null, "position": [x,y], "traffic_heading_deg": rumbo del tráfico al que se dirige}],
  "markings": [{"type": "linea_detencion"|"paso_peatones"|"linea_continua"|"flecha"|"otro", "position": [x,y], "heading_deg": rumbo de la marcha afectada, "length_px": número o null}],
  "objects": [{"type": "arbol"|"farola"|"poste"|"edificio"|"muro"|"valla"|"guardarrail"|"bordillo"|"isleta"|"restos"|"otro", "position": [x,y], "label": texto o null}],
  "texts": [{"text": texto literal, "position": [x,y] o null, "meaning": "road_name"|"direction"|"pk"|"cause"|"legend"|"note"|"scale"|"other"}],
  "summary": "2–3 frases en español: qué vía es, qué hacía cada vehículo y cómo chocaron, tal como lo muestra el croquis",
  "uncertainties": ["lo que no está claro"]
}

Sé preciso con las coordenadas (son lo que se usará para dibujar la escena) y no inventes elementos que no estén en el dibujo.`;
}

/** Saca el primer objeto JSON de un texto (por si viene en un bloque de código o con texto alrededor). */
export function parseJsonLoose(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('La respuesta no contiene JSON');
  return JSON.parse(body.slice(a, b + 1));
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && isFinite(Number(v)) ? Number(v) : d);
const xy = (v: unknown): XY | null => (Array.isArray(v) && v.length >= 2 && isFinite(num(v[0], NaN)) && isFinite(num(v[1], NaN)) ? [num(v[0]), num(v[1])] : null);
const ROLES: SketchRole[] = ['ini', 'col', 'fin', 'mid'];

/** Valida y normaliza la respuesta (tolera campos ausentes o mal tipados). */
export function normalizeSketch(raw: unknown): SketchResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  const roads: SketchRoad[] = arr(r.roads)
    .map((x) => ({
      name: typeof x.name === 'string' ? x.name : null,
      kind: typeof x.kind === 'string' ? x.kind : 'convencional',
      centerline: arr(x.centerline).map(xy).filter((p): p is XY => !!p),
      width_px: num(x.width_px, 0),
      lanes: Math.max(1, Math.round(num(x.lanes, 2))),
      main: x.main === true,
      direction_note: typeof x.direction_note === 'string' ? x.direction_note : null,
    }))
    .filter((x) => x.centerline.length >= 2);
  const vehicles: SketchVehicle[] = arr(r.vehicles)
    .map((v, i) => ({
      label: (typeof v.label === 'string' && v.label.trim()) || String.fromCharCode(65 + i),
      type: typeof v.type === 'string' ? v.type : 'turismo',
      description: typeof v.description === 'string' ? v.description : '',
      positions: arr(v.positions)
        .map((p) => {
          const c = xy(p.center);
          if (!c) return null;
          const role = ROLES.includes(p.role as SketchRole) ? (p.role as SketchRole) : 'mid';
          return { tag: typeof p.tag === 'string' ? p.tag : '', role, center: c, heading_deg: num(p.heading_deg, 0), length_px: num(p.length_px, 0) || null, width_px: num(p.width_px, 0) || null, confidence: num(p.confidence, 0.7) } as SketchPosition;
        })
        .filter((p): p is SketchPosition => !!p),
    }))
    .filter((v) => v.positions.length);
  const isz = r.image_size as Record<string, unknown> | undefined;
  return {
    image_size: isz ? { width: num(isz.width), height: num(isz.height) } : undefined,
    north_deg: r.north_deg == null ? null : num(r.north_deg, 0),
    meters_per_px: r.meters_per_px == null ? null : num(r.meters_per_px, 0) || null,
    scale_evidence: typeof r.scale_evidence === 'string' ? r.scale_evidence : null,
    roads,
    vehicles,
    impact: xy(r.impact),
    signs: arr(r.signs)
      .map((s) => ({ type: String(s.type ?? 'otro'), value: s.value == null ? null : String(s.value), position: xy(s.position)!, traffic_heading_deg: s.traffic_heading_deg == null ? null : num(s.traffic_heading_deg) }))
      .filter((s) => s.position),
    markings: arr(r.markings)
      .map((s) => ({ type: String(s.type ?? 'otro'), position: xy(s.position)!, heading_deg: s.heading_deg == null ? null : num(s.heading_deg), length_px: s.length_px == null ? null : num(s.length_px) }))
      .filter((s) => s.position),
    objects: arr(r.objects)
      .map((s) => ({ type: String(s.type ?? 'otro'), position: xy(s.position)!, label: s.label == null ? null : String(s.label) }))
      .filter((s) => s.position),
    texts: arr(r.texts)
      .map((s) => ({ text: String(s.text ?? ''), position: xy(s.position), meaning: typeof s.meaning === 'string' ? s.meaning : 'other' }))
      .filter((s) => s.text),
    summary: typeof r.summary === 'string' ? r.summary : '',
    uncertainties: arr(r.uncertainties).map(String),
  };
}
