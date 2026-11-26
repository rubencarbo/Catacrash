import { emptyProject, LINEAR_DEFS, ROAD_PRESETS } from './defaults';
import { newId } from './store';
import type { CtrlPoint, Entity, LinearType, Params, Project, VehicleEntity } from './types';
import { samplePath } from '../scene/spline';
import { CATALOG } from '../scene/props';
import { specFromRecord } from '../vehicles/spec';
import { rng, valueNoise2D } from '../scene/utils';

/**
 * Escenario de ejemplo: carretera convencional 1+1 a media ladera, con curva,
 * terraplén hacia un barranco con río, desmonte con muro, tendido eléctrico,
 * vegetación, señalización y un croquis de calco.
 */
export function demoProject(): { project: Project; assets: Map<string, string> } {
  const p = emptyProject();
  p.name = 'Ejemplo: colisión frontal en curva';
  p.env = { hour: 11.5, month: 10, wet: false, fog: 0 };
  const { size, segs, base } = p.terrain;
  const n = segs + 1;
  const half = size / 2;
  const step = size / segs;
  const vn = valueNoise2D(21);
  const valleyX = (z: number) => 42 + 10 * Math.sin(z / 50);
  const H = (x: number, z: number) => {
    const v = x - valleyX(z);
    return -0.13 * x - 21 * Math.exp(-((v / 17) ** 2)) + vn(x / 55, z / 55) * 3 + vn(x / 14, z / 14) * 0.4;
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) base[j * n + i] = H(-half + i * step, -half + j * step);

  const E: Entity[] = [];
  const pts = (arr: [number, number][]): CtrlPoint[] => arr.map(([x, z]) => ({ x, z, h: null }));
  const linear = (type: LinearType, name: string, arr: [number, number][], params: Params = {}) =>
    E.push({ id: newId('l'), kind: 'linear', type, name, points: pts(arr), params: { ...LINEAR_DEFS[type].defaults, ...params } });
  const prop = (type: string, name: string, x: number, z: number, rot = 0, params: Params = {}) =>
    E.push({ id: newId('p'), kind: 'prop', type, name, x, z, rot, dy: 0, params: { ...CATALOG[type].defaults, ...params } });

  // Río por el fondo del barranco
  const riverPts: [number, number][] = [];
  for (let z = -150; z <= 150; z += 30) riverPts.push([valleyX(z), z]);
  E.push({ id: newId('w'), kind: 'river', name: 'Arroyo', points: pts(riverPts), width: 5, depth: 1, bank: 5, levelOffset: -0.6 });

  // Carretera principal (sentido norte → sur)
  const road: [number, number][] = [
    [-58, -150],
    [-36, -95],
    [-12, -45],
    [-4, 0],
    [-16, 50],
    [-44, 100],
    [-62, 150],
  ];
  E.push({ id: newId('r'), kind: 'road', name: 'Carretera CV-123', points: pts(road), profile: ROAD_PRESETS.convencional.make() });
  const prof = E[E.length - 1];
  if (prof.kind === 'road') {
    prof.profile.center = 'continua';
    prof.priority = 2;
  }

  // Camino de tierra que sale hacia el oeste
  E.push({
    id: newId('r'),
    kind: 'road',
    name: 'Camino agrícola',
    points: pts([
      [-21, -62],
      [-45, -70],
      [-85, -66],
      [-140, -80],
    ]),
    profile: ROAD_PRESETS.camino.make(),
    priority: 0,
  });
  // Chaflanes del cruce con el camino (áreas de tierra compactada que enlazan los bordes)
  const area = (name: string, arr: [number, number][]) =>
    E.push({ id: newId('a'), kind: 'area', name, points: pts(arr), material: 'tierra', raise: 0, talud: 1.5, angle: 0 });
  area('Chaflán sur del cruce', [
    [-21.6, -56.7],
    [-23.6, -60.7],
    [-28.0, -62.4],
    [-24.4, -59.95],
  ]);
  area('Chaflán norte del cruce', [
    [-28.7, -70.65],
    [-26.4, -66.23],
    [-31.0, -68.14],
    [-28.65, -68.3],
  ]);

  // Guardarraíl en el lado del barranco (este), muro en el desmonte (oeste)
  linear('guardarrail', 'Bionda lado barranco', [
    [-6.5, -40],
    [1.4, 0],
    [-9.5, 45],
    [-31, 82],
  ], { lado: 'derecha' });
  linear('muro', 'Muro de mampostería', [
    [-21, -10],
    [-17.5, 18],
    [-24, 42],
  ], { altura: 1.8, material: 'piedra', curva: true });
  linear('tendido', 'Línea telefónica', [
    [-80, -150],
    [-62, -100],
    [-40, -52],
    [-30, -5],
    [-38, 45],
    [-62, 95],
    [-80, 145],
  ], { altura: 8, cables: 2, poste: 'madera', flecha: 1 });
  linear('valla', 'Valla de la finca', [
    [-95, -30],
    [-62, -36],
    [-55, -6],
    [-90, 5],
  ], { altura: 1.4, tipo: 'malla' });

  // Construcciones
  prop('edificio', 'Casa de campo', -75, -18, 12, { ancho: 11, fondo: 8, plantas: 2, color: '#ead9bd' });
  prop('caseta', 'Almacén', -66, 2, 12, { ancho: 4, fondo: 3, alto: 2.6 });

  // Vegetación
  const r = rng(5);
  for (let i = 0; i < 46; i++) {
    const z = -140 + r() * 280;
    const x = -150 + r() * 70;
    if (x > -70 && x < -50 && z > -40 && z < 10) continue;
    const sp = r() > 0.35 ? 'pinonero' : 'pino';
    prop('arbol', `Pino ${i + 1}`, x, z, r() * 360, { especie: sp, altura: 8 + r() * 6, copa: 5 + r() * 4, tronco: 0.35 + r() * 0.2 });
  }
  for (let i = 0; i < 22; i++) {
    const z = -145 + i * 13 + r() * 5;
    const side = i % 2 ? 1 : -1;
    const x = valleyX(z) + side * (4.5 + r() * 3);
    prop('arbol', `Chopo ${i + 1}`, x, z, r() * 360, { especie: 'chopo', altura: 12 + r() * 6, copa: 3 + r(), tronco: 0.35, hoja: i % 5 === 0 ? 'otono' : 'claro' });
  }
  for (let gx = 0; gx < 6; gx++)
    for (let gz = 0; gz < 7; gz++) {
      const x = 78 + gx * 8 + r() * 1.2;
      const z = -70 + gz * 8 + r() * 1.2;
      prop('arbol', `Olivo ${gx * 7 + gz + 1}`, x, z, r() * 360, { especie: 'olivo', altura: 4 + r() * 1.2, copa: 4.5, tronco: 0.4 });
    }
  for (let i = 0; i < 26; i++) {
    const z = -140 + r() * 280;
    const x = valleyX(z) - 8 - r() * 22;
    if (Math.abs(x - (-8 + 0)) < 8 && Math.abs(z) < 60) continue;
    prop('arbol', `Arbusto ${i + 1}`, x, z, r() * 360, { especie: 'arbusto', altura: 1 + r(), copa: 1.5 + r() * 1.5, hoja: 'oscuro' });
  }
  for (let i = 0; i < 8; i++) prop('roca', `Roca ${i + 1}`, valleyX(-100 + i * 25) + (r() - 0.5) * 6, -100 + i * 25, r() * 360, { tamano: 0.8 + r() * 1.5 });

  // Señalización (la cara mira a +Z con rumbo 0 → hacia el tráfico que sube hacia el norte)
  prop('senal', 'Velocidad 60 (sentido sur)', -40, -95, 160, { senal: 'velocidad', valor: '60' });
  prop('senal', 'Curva peligrosa (sentido sur)', -24, -60, 165, { senal: 'curva_izq' });
  prop('senal', 'Adelantamiento prohibido (sentido sur)', -20.5, -48, 165, { senal: 'adelantar' });
  prop('senal', 'Curva peligrosa (sentido norte)', -15, 62, 335, { senal: 'curva_der' });
  prop('senal', 'Velocidad 60 (sentido norte)', -32, 92, 330, { senal: 'velocidad', valor: '60' });
  prop('hito_km', 'PK 12', -21, -30, 100, { pk: '12' });
  // Hitos de arista a ambos lados
  const hitos: [number, number][] = [
    [-30, -80], [-20, -60], [-13, -42], [-8, -22], [-5.5, 0], [-8, 22], [-14, 42], [-24, 63], [-37, 84],
  ];
  hitos.forEach(([x, z], i) => {
    prop('hito_arista', `Hito de arista O${i + 1}`, x - 6, z, 90);
    prop('hito_arista', `Hito de arista E${i + 1}`, x + 6, z, 270);
  });
  prop('farola', 'Farola acceso finca', -27, -55, 90, { altura: 7 });
  prop('contenedor', 'Contenedor', -35, -74, 70, { tipo: 'resto' });

  // Vehículos implicados en sus posiciones finales (según el croquis), con daños frontales
  const leon = specFromRecord({ marca: 'Seat', modelo: 'Leon', generacion: 'Seat Leon III', desde: 2012, hasta: 2016, carroceria: 'Hatchback', masa: 1346, mma: 1910, L: 4271, W: 1816, H: 1435, batalla: 2631, viaD: 1536, viaT: 1510, traccion: 'Tracción delantera', neumaticos: '225/40 R18', fuente: 'https://www.auto-data.net/es/seat-leon-iii-cupra-2.0-tsi-290hp-dsg-22733' });
  const ateca = specFromRecord({ marca: 'Seat', modelo: 'Ateca', generacion: 'Seat Ateca I', desde: 2016, hasta: 2020, carroceria: 'SUV', masa: 1466, mma: 2080, L: 4363, W: 1841, H: 1611, batalla: 2630, viaD: 1572, viaT: 1544, volD: 868, volT: 865, traccion: 'Tracción en todas las ruedas (4x4)', neumaticos: '215/50 R18', fuente: 'https://www.auto-data.net/es/seat-ateca-i-2.0-tsi-190hp-4drive-dsg-51365' });
  E.push({
    id: newId('v'), kind: 'vehicle', name: 'A · Seat León III', label: 'A', spec: leon, x: -4.1, z: 8.3, heading: 318, color: '#b71c1c', plate: '4821 HZK', occupants: 1, cargo: 0, photos: [],
    damage: [],
  });
  E.push({
    id: newId('v'), kind: 'vehicle', name: 'B · Seat Ateca', label: 'B', spec: ateca, x: -0.5, z: 5.2, heading: 6, color: '#1e4f8f', plate: '1290 KLM', occupants: 2, cargo: 0, photos: [],
    damage: [],
  });

  // Conducción simulada: rutas por los carriles, velocidades y acciones de los conductores (0 = impacto)
  {
    const S = samplePath(pts(road), () => 0, 0.5, true);
    const iImp = S.reduce((b, q, i) => (Math.abs(q.z - 3) < Math.abs(S[b].z - 3) ? i : b), 0);
    const sImp = S[iImp].s;
    // punto a distancia s del trazado y desplazamiento lateral o (+ = oeste en sentido sur)
    const at = (sv: number, o: number): CtrlPoint => {
      let k = 0;
      while (k < S.length - 2 && S[k + 1].s < sv) k++;
      const q = S[k];
      return { x: q.x - q.tz * o, z: q.z + q.tx * o, h: null };
    };
    const A = E.find((e) => e.kind === 'vehicle' && e.label === 'A') as VehicleEntity;
    const B = E.find((e) => e.kind === 'vehicle' && e.label === 'B') as VehicleEntity;
    // A (sentido sur) se va abriendo hacia el carril contrario en la curva
    A.drive = {
      path: [at(sImp - 140, 1.75), at(sImp - 90, 1.75), at(sImp - 45, 1.5), at(sImp - 18, 0.2), at(sImp, -1.3), at(sImp + 25, -2.6)],
      speed: 85,
      sync: true,
      abs: true,
      events: [{ id: newId('ev'), t: -0.25, action: 'frenar', value: 1 }],
      showFinal: true,
    };
    // B (sentido norte) por su carril: frena a fondo y da un volantazo a la derecha
    B.drive = {
      path: [at(sImp + 140, -1.75), at(sImp + 80, -1.75), at(sImp + 20, -1.75), at(sImp, -1.75), at(sImp - 30, -1.75)],
      speed: 60,
      sync: true,
      abs: true,
      events: [
        { id: newId('ev'), t: -0.85, action: 'frenar', value: 1 },
        { id: newId('ev'), t: -0.8, action: 'girar', value: 6 },
      ],
      showFinal: true,
    };
    p.impact = at(sImp, -1.2);
    p.timeline = { start: -4, end: 4 };
  }

  p.entities = E;

  // Croquis de ejemplo dibujado a mano (calco)
  const assets = new Map<string, string>();
  const sketch = makeSketch();
  if (sketch) {
    const asset = newId('img');
    assets.set(asset, sketch);
    E.unshift({ id: newId('o'), kind: 'overlay', name: 'Croquis manuscrito (ejemplo)', asset, cx: -6, cz: 0, width: 46, aspect: 1.25, rot: 0, opacity: 0.9, onRoads: true, hidden: true });
  }
  return { project: p, assets };
}

/** Croquis de ejemplo con aspecto de dibujo a mano (para probar los calcos). */
function makeSketch(): string | null {
  if (typeof document === 'undefined') return null;
  const W = 800;
  const Hh = 1000;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = Hh;
  const g = c.getContext('2d')!;
  const r = rng(3);
  const k = W / 46; // px por metro
  const X = (x: number) => W / 2 + (x + 6) * k;
  const Z = (z: number) => Hh / 2 + z * k;
  const jitter = () => (r() - 0.5) * 2;
  const pen = (color: string, w: number) => {
    g.strokeStyle = color;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.lineJoin = 'round';
  };
  const curve = (pts: [number, number][]) => {
    g.beginPath();
    pts.forEach(([x, z], i) => (i ? g.lineTo(X(x) + jitter(), Z(z) + jitter()) : g.moveTo(X(x), Z(z))));
    g.stroke();
  };
  // Bordes de la calzada
  pen('#1b2a6b', 4);
  const axis: [number, number][] = [];
  for (let z = -30; z <= 30; z += 3) axis.push([-4 - 0.0045 * z * z * (z > 0 ? 1.4 : 0.9), z]);
  curve(axis.map(([x, z]) => [x - 4.5, z]));
  curve(axis.map(([x, z]) => [x + 4.5, z]));
  g.setLineDash([18, 22]);
  pen('#1b2a6b', 3);
  curve(axis);
  g.setLineDash([]);
  // Vehículos: posiciones inicial (discontinuo), colisión y final
  const car = (x: number, z: number, ang: number, label: string, color: string, dashed = false) => {
    g.save();
    g.translate(X(x), Z(z));
    g.rotate(ang);
    pen(color, 4);
    if (dashed) g.setLineDash([10, 8]);
    g.strokeRect(-0.9 * k, -2.2 * k, 1.8 * k, 4.4 * k);
    g.beginPath();
    g.moveTo(-0.9 * k, -1.2 * k);
    g.lineTo(0.9 * k, -1.2 * k);
    g.stroke();
    g.setLineDash([]);
    g.rotate(-ang);
    g.fillStyle = color;
    g.font = 'bold 34px "Comic Sans MS", "Segoe Print", cursive';
    g.textAlign = 'center';
    g.fillText(label, 0, 12);
    g.restore();
  };
  car(-4.5, -25, Math.PI, 'A1', '#b01c1c', true);
  car(-3.5, 1, Math.PI + 0.25, 'A2', '#b01c1c');
  car(-4.4, 7.8, (323 * Math.PI) / 180, 'A3', '#b01c1c');
  car(-6.5, 24, -0.25, 'B1', '#0d6b2f', true);
  car(-4.3, 5.2, -0.1, 'B2', '#0d6b2f');
  car(-0.2, 4.9, (2 * Math.PI) / 180, 'B3', '#0d6b2f');
  // Trayectorias
  pen('#b01c1c', 2.5);
  curve([[-4.5, -22], [-3.5, -12], [-2.8, -3]]);
  pen('#0d6b2f', 2.5);
  curve([[-6.5, 21], [-5.5, 14], [-4.6, 8]]);
  // Punto de colisión
  pen('#111', 3);
  g.beginPath();
  g.arc(X(-3.8), Z(3.2), 0.9 * k, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#111';
  g.font = '30px "Comic Sans MS", "Segoe Print", cursive';
  g.fillText('X  colisión', X(-2.5), Z(3.6));
  g.fillText('N ↑', 40, 50);
  g.fillText('hacia Valverde ↓', W - 260, Hh - 30);
  g.fillText('frenada A', X(-9.5), Z(-9));
  pen('#555', 2);
  g.setLineDash([4, 6]);
  curve([[-4.8, -16], [-4.2, -6]]);
  curve([[-3.2, -16], [-2.6, -6]]);
  return c.toDataURL('image/png');
}
