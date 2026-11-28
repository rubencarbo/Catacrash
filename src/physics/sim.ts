import type { DamageSide, DamageZone, DriverEvent, VehicleEntity } from '../model/types';
import { TWO_WHEELS } from '../vehicles/spec';
import { Path } from './path';

/**
 * Simulación física en planta (3 grados de libertad por vehículo: x, z, guiñada).
 *
 * - Neumáticos: fuerza lateral por ángulo de deriva, frenada (con ABS o bloqueo), tracción y
 *   rodadura, limitadas por el círculo de fricción μ·Fz. La carga Fz de cada rueda incluye la
 *   transferencia longitudinal y lateral según la altura del centro de gravedad.
 * - Contactos: carrocerías como rectángulos; la fuerza normal es proporcional a la penetración
 *   (rigidez de aplastamiento ∝ masa, en serie entre los dos cuerpos) con descarga rígida
 *   (restitución baja, deformación permanente) y rozamiento entre carrocerías. El punto de
 *   aplicación genera par de giro, así que los vehículos rotan de forma natural.
 * - Conductor: sigue su ruta (persecución pura) a la velocidad indicada hasta que actúan sus
 *   acciones (frenar, girar, acelerar…). Tras el primer impacto pierde el control.
 *
 * No es un programa pericial certificado: busca un comportamiento físicamente coherente.
 */

const G = 9.81;
const DT = 0.001;
const REC = 10; // grabar cada 10 pasos (100 Hz)
/** Tiempo de reacción del conductor tras el choque antes de frenar (s). */
const POST_REACTION = 0.8;

export type SurfaceKind = 'asfalto' | 'tierra' | 'hierba';

export interface Obstacle {
  id: string;
  name: string;
  /** Centro, semilongitud según el eje, semianchura, ángulo del eje (rad, desde +x hacia +z). */
  cx: number;
  cz: number;
  hl: number;
  hw: number;
  ang: number;
  /** Rigidez (N/m). Infinity = rígido. */
  k: number;
  kind: string;
}

export interface SimInput {
  vehicles: VehicleEntity[];
  start: number;
  end: number;
  impact: { x: number; z: number } | null;
  wet: boolean;
  surfaceH: (x: number, z: number) => number;
  surfaceKind: (x: number, z: number) => SurfaceKind;
  obstacles: Obstacle[];
}

export interface Frame {
  t: number;
  /** Centro geométrico de la huella. */
  x: number;
  z: number;
  /** Rumbo (grados). */
  h: number;
  /** Velocidad (m/s). */
  v: number;
  /** Aceleraciones en ejes del vehículo (m/s²): adelante y derecha. */
  ax: number;
  ay: number;
  /** Giro de las ruedas delanteras (rad). */
  steer: number;
  /** Velocidad (m/s) en ejes del mundo. */
  vx: number;
  vz: number;
}

export interface MarkStrip {
  pts: { t: number; x: number; z: number }[];
  width: number;
}

export interface SimContact {
  a: string;
  b: string;
  bName: string;
  t0: number;
  t1: number;
  x: number;
  z: number;
  peakForce: number;
  crushA: number;
  crushB: number;
  dvA: number;
  dvB: number;
  /** Energía disipada en el contacto (J). */
  energy: number;
}

export interface SimVehicle {
  id: string;
  frames: Frame[];
  marks: MarkStrip[];
  autoDamage: DamageZone[];
  firstContact: number | null;
  /** Velocidad justo antes del primer contacto (m/s). */
  impactSpeed: number | null;
  /** Momento en que queda en reposo. */
  restTime: number | null;
}

export interface SimResult {
  vehicles: Map<string, SimVehicle>;
  contacts: SimContact[];
  firstContact: number | null;
  start: number;
  end: number;
  /** Desplazamiento de inicio aplicado por la sincronización (m a lo largo de la ruta). */
  syncOffsets: Map<string, number>;
}

// ---------------------------------------------------------------------------

interface Wheel {
  lf: number; // posición longitudinal respecto al CDG (+ adelante)
  lr: number; // lateral (+ derecha)
  front: boolean;
  driven: boolean;
  width: number;
  strip: MarkStrip | null;
  sliding: boolean;
}

class Body {
  e: VehicleEntity;
  id: string;
  kind: 'car' | 'two' | 'ped' | 'static';
  m: number;
  Iz: number;
  L: number;
  W: number;
  /** Distancia del CDG al centro geométrico (+ si el CDG está por delante). */
  cgAhead: number;
  a: number;
  b: number;
  h: number;
  wheels: Wheel[] = [];
  x = 0;
  z = 0;
  vx = 0;
  vz = 0;
  psi = 0;
  w = 0;
  steer = 0;
  brake = 0;
  throttle = 0;
  abs = true;
  axf = 0;
  ayf = 0;
  controlled = true;
  hadContact = false;
  rested = false;
  slopeTick = 0;
  gx = 0;
  gz = 0;
  path: Path | null = null;
  pathS = 0;
  cruise = 0;
  events: DriverEvent[] = [];
  ped0 = 0; // distancia inicial en ruta (peatones)
  fx = 0;
  fz = 0;
  tq = 0;
  frames: Frame[] = [];
  marks: MarkStrip[] = [];
  firstContact: number | null = null;
  impactSpeed: number | null = null;
  restTime: number | null = null;
  /** Instante en que el conductor perdió el control (primer choque). */
  lostControl: number | null = null;

  constructor(e: VehicleEntity) {
    this.e = e;
    this.id = e.id;
    const sp = e.spec;
    this.kind = !e.drive ? 'static' : sp.tipo === 'peaton' ? 'ped' : TWO_WHEELS.includes(sp.tipo) ? 'two' : 'car';
    const extra = sp.tipo === 'peaton' ? 0 : Math.max(0, e.occupants - 1) * 75 + e.cargo;
    this.m = Math.max(30, sp.masa + extra);
    this.Iz = Math.max(5, sp.inercia * (this.m / Math.max(1, sp.masa)));
    this.L = Math.max(0.3, sp.L);
    this.W = Math.max(0.3, sp.W);
    this.a = Math.max(0.05, sp.cdgEje);
    this.b = Math.max(0.05, sp.batalla - sp.cdgEje);
    this.h = sp.cdgAltura;
    const cgFromFront = sp.volD + this.a;
    this.cgAhead = this.L / 2 - cgFromFront;
    this.abs = e.drive?.abs ?? true;
    const tw = Math.min(0.3, Math.max(0.1, sp.W * 0.11));
    if (sp.tipo === 'peaton') return;
    if (this.kind === 'two' || (this.kind === 'static' && TWO_WHEELS.includes(sp.tipo))) {
      this.wheels.push({ lf: this.a, lr: 0, front: true, driven: false, width: tw, strip: null, sliding: false });
      this.wheels.push({ lf: -this.b, lr: 0, front: false, driven: true, width: tw, strip: null, sliding: false });
    } else {
      const fd = sp.traccion !== 'trasera';
      const rd = sp.traccion !== 'delantera';
      for (const s of [-1, 1]) this.wheels.push({ lf: this.a, lr: (s * sp.viaD) / 2, front: true, driven: fd, width: tw, strip: null, sliding: false });
      for (const s of [-1, 1]) this.wheels.push({ lf: -this.b, lr: (s * sp.viaT) / 2, front: false, driven: rd, width: tw, strip: null, sliding: false });
    }
  }

  get fwd(): [number, number] {
    return [Math.sin(this.psi), -Math.cos(this.psi)];
  }
  get right(): [number, number] {
    return [Math.cos(this.psi), Math.sin(this.psi)];
  }
  get speed() {
    return Math.hypot(this.vx, this.vz);
  }
  /** Centro geométrico (para la caja de colisión y el dibujo). */
  center(): [number, number] {
    const [fx, fz] = this.fwd;
    return [this.x - fx * this.cgAhead, this.z - fz * this.cgAhead];
  }
  rect(): [number, number][] {
    const [cx, cz] = this.center();
    const [fx, fz] = this.fwd;
    const [rx, rz] = this.right;
    const l = this.L / 2;
    const w = this.W / 2;
    return [
      [cx + fx * l - rx * w, cz + fz * l - rz * w],
      [cx + fx * l + rx * w, cz + fz * l + rz * w],
      [cx - fx * l + rx * w, cz - fz * l + rz * w],
      [cx - fx * l - rx * w, cz - fz * l - rz * w],
    ];
  }
  /** Velocidad de un punto del cuerpo. */
  pointVel(px: number, pz: number): [number, number] {
    const ox = px - this.x;
    const oz = pz - this.z;
    return [this.vx - this.w * oz, this.vz + this.w * ox];
  }
  applyForce(Fx: number, Fz: number, px: number, pz: number) {
    this.fx += Fx;
    this.fz += Fz;
    this.tq += (px - this.x) * Fz - (pz - this.z) * Fx;
  }
  /**
   * Rigidez de la carrocería frente al aplastamiento (N/m, a todo lo ancho). Si se da la normal del
   * golpe (hacia fuera del vehículo, en el mundo), el costado es bastante más blando que el frontal
   * (valores medios de ensayos: frontal ≈ 1 MN/m en un compacto, lateral ≈ 0,55 de eso).
   */
  stiffness(nx?: number, nz?: number) {
    if (this.kind === 'ped') return 4e4;
    if (this.kind === 'two' || TWO_WHEELS.includes(this.e.spec.tipo)) return 2.5e5;
    const k = 800 * this.m;
    if (nx === undefined || nz === undefined) return k;
    const [fx, fz] = this.fwd;
    const lon = Math.abs(nx * fx + nz * fz);
    return k * (0.55 + 0.45 * lon);
  }
}

// ---------------- geometría de contacto ----------------

type Poly = [number, number][];

function clip(subject: Poly, clipper: Poly): Poly {
  let out = subject;
  for (let i = 0; i < clipper.length; i++) {
    const [ax, az] = clipper[i];
    const [bx, bz] = clipper[(i + 1) % clipper.length];
    const inside = (p: [number, number]) => (bx - ax) * (p[1] - az) - (bz - az) * (p[0] - ax) >= 0;
    const inter = (p: [number, number], q: [number, number]): [number, number] => {
      const a1 = bz - az;
      const b1 = ax - bx;
      const c1 = a1 * ax + b1 * az;
      const a2 = q[1] - p[1];
      const b2 = p[0] - q[0];
      const c2 = a2 * p[0] + b2 * p[1];
      const det = a1 * b2 - a2 * b1 || 1e-12;
      return [(b2 * c1 - b1 * c2) / det, (a1 * c2 - a2 * c1) / det];
    };
    const input = out;
    out = [];
    if (!input.length) break;
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const pin = inside(p);
      const qin = inside(q);
      if (pin && qin) out.push(q);
      else if (pin && !qin) out.push(inter(p, q));
      else if (!pin && qin) out.push(inter(p, q), q);
    }
  }
  return out;
}

/** Orienta un polígono en sentido antihorario (para el recorte). */
function ccw(p: Poly): Poly {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, z0] = p[i];
    const [x1, z1] = p[(i + 1) % p.length];
    a += x0 * z1 - x1 * z0;
  }
  return a < 0 ? [...p].reverse() : p;
}

interface Hit {
  d: number;
  nx: number;
  nz: number;
  cx: number;
  cz: number;
  width: number;
  poly: Poly;
}

/**
 * Contacto entre dos rectángulos: penetración (SAT), normal de A hacia B y zona de solape.
 * Si se da `axis`, la penetración se mide en esa dirección (normal mantenida durante el choque).
 */
function collide(A: Poly, B: Poly, ca: [number, number], cb: [number, number], axis?: [number, number]): Hit | null {
  let d = Infinity;
  let nx = 0;
  let nz = 0;
  for (const P of [A, B]) {
    for (let i = 0; i < 2; i++) {
      const [x0, z0] = P[i];
      const [x1, z1] = P[i + 1];
      let ax = -(z1 - z0);
      let az = x1 - x0;
      const l = Math.hypot(ax, az) || 1;
      ax /= l;
      az /= l;
      let a0 = Infinity;
      let a1 = -Infinity;
      let b0 = Infinity;
      let b1 = -Infinity;
      for (const [x, z] of A) {
        const v = x * ax + z * az;
        a0 = Math.min(a0, v);
        a1 = Math.max(a1, v);
      }
      for (const [x, z] of B) {
        const v = x * ax + z * az;
        b0 = Math.min(b0, v);
        b1 = Math.max(b1, v);
      }
      const ov = Math.min(a1, b1) - Math.max(a0, b0);
      if (ov <= 0) return null;
      if (ov < d) {
        d = ov;
        nx = ax;
        nz = az;
      }
    }
  }
  if (axis) {
    // profundidad según la normal fijada: cuánto entra B en A en esa dirección
    nx = axis[0];
    nz = axis[1];
    let aMax = -Infinity;
    let bMin = Infinity;
    for (const [x, z] of A) aMax = Math.max(aMax, x * nx + z * nz);
    for (const [x, z] of B) bMin = Math.min(bMin, x * nx + z * nz);
    d = aMax - bMin;
    if (d <= 0) return null;
  } else if ((cb[0] - ca[0]) * nx + (cb[1] - ca[1]) * nz < 0) {
    nx = -nx;
    nz = -nz;
  }
  const poly = clip(ccw(A), ccw(B));
  if (poly.length < 3) return null;
  let cx = 0;
  let cz = 0;
  for (const [x, z] of poly) {
    cx += x;
    cz += z;
  }
  cx /= poly.length;
  cz /= poly.length;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const [x, z] of poly) {
    const v = -x * nz + z * nx;
    t0 = Math.min(t0, v);
    t1 = Math.max(t1, v);
  }
  return { d, nx, nz, cx, cz, width: Math.max(0.05, t1 - t0), poly };
}

function obstacleRect(o: Obstacle): Poly {
  const c = Math.cos(o.ang);
  const s = Math.sin(o.ang);
  return [
    [o.cx + c * o.hl - s * o.hw, o.cz + s * o.hl + c * o.hw],
    [o.cx - c * o.hl - s * o.hw, o.cz - s * o.hl + c * o.hw],
    [o.cx - c * o.hl + s * o.hw, o.cz - s * o.hl - c * o.hw],
    [o.cx + c * o.hl + s * o.hw, o.cz + s * o.hl - c * o.hw],
  ];
}

// ---------------- conductor ----------------

function driverState(events: DriverEvent[], t: number) {
  let pedal: DriverEvent | null = null;
  let steer: DriverEvent | null = null;
  for (const ev of events) {
    if (ev.t > t) continue;
    if (ev.action === 'girar' || ev.action === 'recto') {
      if (!steer || ev.t >= steer.t) steer = ev;
    } else if (!pedal || ev.t >= pedal.t) pedal = ev;
  }
  return { pedal, steer };
}

function drive(b: Body, t: number) {
  if (b.kind !== 'car' && b.kind !== 'two') return;
  if (!b.controlled) {
    b.throttle = 0;
    // tras el choque: arrastre por los daños (ruedas y chapa) y, pasado el tiempo de reacción,
    // frenada del conductor (lo habitual; se puede quitar en la ficha de conducción)
    if (b.lostControl !== null) {
      const pb = b.e.drive?.postBrake ?? 0.6;
      const since = t - b.lostControl;
      b.brake = Math.max(0.2, since > POST_REACTION ? pb : 0);
    }
    return;
  }
  const [fx, fz] = b.fwd;
  const [rx, rz] = b.right;
  const u = b.vx * fx + b.vz * fz;
  const { pedal, steer } = driverState(b.events, t);
  // Pedales
  if (!pedal) {
    const err = b.cruise - u;
    b.throttle = Math.max(0, Math.min(0.6, err * 0.6));
    b.brake = Math.max(0, Math.min(0.35, -err * 0.25));
  } else if (pedal.action === 'frenar') {
    b.brake = Math.max(0, Math.min(1, pedal.value));
    b.throttle = 0;
  } else if (pedal.action === 'acelerar') {
    b.throttle = Math.max(0, Math.min(1, pedal.value));
    b.brake = 0;
  } else {
    b.throttle = 0;
    b.brake = 0;
  }
  // Dirección: persecución pura desde el eje trasero
  let target = 0;
  if (b.path) {
    const px = b.x - fx * b.b;
    const pz = b.z - fz * b.b;
    // proyección local sobre los tramos vecinos (sin retroceder más de 3 m ni saltar más de 6 m)
    const bestS = Math.max(b.pathS - 3, Math.min(b.pathS + 6, b.path.projectNear(px, pz, b.pathS)));
    b.pathS = bestS;
    const Ld = Math.max(4, Math.min(25, 0.9 * Math.abs(u) + 3));
    const [tx, tz] = b.path.point(bestS + Ld);
    const dx = tx - px;
    const dz = tz - pz;
    const alpha = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
    target = Math.atan((2 * (b.a + b.b) * Math.sin(alpha)) / Ld);
  }
  if (steer && steer.action === 'girar') target += (steer.value * Math.PI) / 180;
  target = Math.max(-0.6, Math.min(0.6, target));
  const rate = 0.6 * DT; // ≈ 34°/s en las ruedas
  b.steer += Math.max(-rate, Math.min(rate, target - b.steer));
}

// ---------------- simulación ----------------

export const MU: Record<SurfaceKind, [number, number]> = {
  asfalto: [0.85, 0.55],
  tierra: [0.55, 0.4],
  hierba: [0.45, 0.32],
};

function initBody(b: Body, input: SimInput, s0: number | null) {
  const e = b.e;
  if (b.kind === 'static' || !e.drive || e.drive.path.length < 2) {
    // en reposo en su posición (centro geométrico en x, z)
    b.psi = (e.heading * Math.PI) / 180;
    const [fx, fz] = b.fwd;
    b.x = e.x + fx * b.cgAhead;
    b.z = e.z + fz * b.cgAhead;
    b.rested = true;
    b.brake = 0.7;
    b.abs = false;
    b.controlled = false;
    return;
  }
  b.path = new Path(e.drive.path);
  b.events = e.drive.events;
  b.cruise = Math.max(0, e.drive.speed / 3.6);
  const s = s0 ?? 0;
  const [tx, tz] = b.path.tangent(s);
  b.psi = Math.atan2(tx, -tz);
  if (b.kind === 'ped') {
    b.ped0 = s;
    const [px, pz] = b.path.point(s);
    b.x = px;
    b.z = pz;
    b.vx = tx * b.cruise;
    b.vz = tz * b.cruise;
    return;
  }
  // eje trasero sobre la ruta
  const [px, pz] = b.path.point(s);
  b.x = px + tx * b.b;
  b.z = pz + tz * b.b;
  b.pathS = s;
  b.vx = tx * b.cruise;
  b.vz = tz * b.cruise;
  void input;
}

interface PairState {
  dmax: number;
  /** Hay un contacto abierto (choque en curso o carrocerías aún solapadas). */
  active: boolean;
  contact: SimContact | null;
  quiet: number;
  peakPoly: Poly;
  crushA: number;
  crushB: number;
  /** Energía del impacto principal que absorbe cada uno (J). */
  eA: number;
  eB: number;
  /** Fuerza del pulso de choque en curso (sobre B; −F sobre A) y pasos que le quedan. */
  F: [number, number];
  left: number;
  /** El pulso en curso es el del impacto principal. */
  mainPulse: boolean;
  /** Mayor impulso de este par (el impacto principal). */
  jMax: number;
  /** Normal del impacto principal (de A hacia B). */
  nx: number;
  nz: number;
  /** Último punto de contacto. */
  px: number;
  pz: number;
  /** Zona de solape y normal hacia fuera en ejes locales de A y B (lateral, longitudinal) en la penetración máxima. */
  locA: Poly;
  locB: Poly;
  nA: [number, number];
  nB: [number, number];
}

const newPair = (): PairState => ({ dmax: 0, active: false, contact: null, quiet: 0, peakPoly: [], crushA: 0, crushB: 0, eA: 0, eB: 0, F: [0, 0], left: 0, mainPulse: false, jMax: 0, nx: 1, nz: 0, px: 0, pz: 0, locA: [], locB: [], nA: [0, 1], nB: [0, 1] });

/** Fuerzas de los neumáticos y la pendiente sobre un cuerpo. */
function tireForces(b: Body, input: SimInput, record: boolean, t: number) {
  if (b.kind === 'ped') {
    if (!b.hadContact) return;
    // tras el atropello: deslizamiento por el suelo
    const v = b.speed;
    if (v > 0.02) {
      const mu = 0.6;
      b.applyForce((-b.vx / v) * mu * b.m * G, (-b.vz / v) * mu * b.m * G, b.x, b.z);
    }
    b.tq += -b.w * b.Iz * 4;
    return;
  }
  const [fx, fz] = b.fwd;
  const [rx, rz] = b.right;
  const wb = b.a + b.b;
  const nW = b.wheels.length;
  // carga estática por eje y transferencias (aceleraciones filtradas)
  const Ff = (b.m * G * b.b) / wb - (b.m * b.axf * b.h) / wb;
  const Fr = (b.m * G * b.a) / wb + (b.m * b.axf * b.h) / wb;
  const nDriven = b.wheels.filter((w) => w.driven).length || 1;
  const maxDrive = b.m * (b.kind === 'two' ? 4 : 3.5);
  for (const wh of b.wheels) {
    const ox = fx * wh.lf + rx * wh.lr;
    const oz = fz * wh.lf + rz * wh.lr;
    const px = b.x + ox;
    const pz = b.z + oz;
    const [vx, vz] = b.pointVel(px, pz);
    const ang = b.psi + (wh.front ? b.steer : 0);
    const wfx = Math.sin(ang);
    const wfz = -Math.cos(ang);
    const wrx = Math.cos(ang);
    const wrz = Math.sin(ang);
    const vl = vx * wfx + vz * wfz;
    const vt = vx * wrx + vz * wrz;
    const axle = wh.front ? Ff : Fr;
    const perAxle = nW === 2 ? 1 : 2;
    let Fz = axle / perAxle;
    if (nW === 4) {
      const track = Math.abs(wh.lr) * 2 || 1.5;
      // aceleración lateral hacia la derecha → carga a la izquierda
      Fz += ((wh.lr < 0 ? 1 : -1) * (axle / G) * b.ayf * b.h) / track / 1;
    }
    Fz = Math.max(30, Fz);
    const kind = input.surfaceKind(px, pz);
    const mu = MU[kind][input.wet ? 1 : 0];
    let Fx = 0;
    let Fy = 0;
    let sliding = false;
    const vmag = Math.hypot(vx, vz);
    const locked = b.brake > 0.9 && !b.abs;
    if (locked) {
      if (vmag > 0.05) {
        const f = mu * 0.9 * Fz;
        Fx = (-vl / vmag) * f;
        Fy = (-vt / vmag) * f;
        sliding = vmag > 0.5;
      } else {
        Fx = -vl * (Fz / G) / (DT * 4);
        Fy = -vt * (Fz / G) / (DT * 4);
      }
    } else {
      const C = 16 * Fz;
      Fy = -C * Math.atan(vt / Math.max(Math.abs(vl), 1.5));
      const brakeF = b.brake * mu * Fz * (b.abs ? 0.95 : 1);
      Fx = -brakeF * Math.tanh(vl / 0.3) - 0.012 * Fz * Math.tanh(vl / 0.5);
      if (wh.driven) Fx += (b.throttle * maxDrive) / nDriven;
      const mag = Math.hypot(Fx, Fy);
      const lim = mu * Fz;
      if (mag > lim) {
        Fx *= lim / mag;
        Fy *= lim / mag;
        sliding = Math.abs(vt) > 1.0;
      }
    }
    const Fwx = wfx * Fx + wrx * Fy;
    const Fwz = wfz * Fx + wrz * Fy;
    b.applyForce(Fwx, Fwz, px, pz);
    // huellas
    if (record) {
      if (sliding) {
        if (!wh.strip) {
          wh.strip = { pts: [], width: wh.width };
          b.marks.push(wh.strip);
        }
        wh.strip.pts.push({ t, x: px, z: pz });
      } else wh.strip = null;
    }
    wh.sliding = sliding;
  }
  // pendiente del terreno (componente del peso en el plano); varía despacio: cada 10 ms
  if (b.slopeTick++ % 10 === 0) {
    const e = 0.6;
    b.gx = (input.surfaceH(b.x + e, b.z) - input.surfaceH(b.x - e, b.z)) / (2 * e);
    b.gz = (input.surfaceH(b.x, b.z + e) - input.surfaceH(b.x, b.z - e)) / (2 * e);
  }
  b.fx += -b.m * G * b.gx;
  b.fz += -b.m * G * b.gz;
}

/**
 * Choque por impulso (modelo de impacto instantáneo usado en reconstrucción, tipo Kudlich-Slibar):
 * en el punto de contacto se conserva el momento lineal y angular, la velocidad relativa normal se
 * invierte con un coeficiente de restitución bajo (la chapa apenas devuelve energía) y la tangencial
 * se anula si el rozamiento entre carrocerías lo permite (si no, deslizan con μ). Por construcción
 * la energía cinética solo puede disminuir; lo que se pierde es la deformación.
 * El impulso se reparte como un pulso de fuerza durante la duración típica del choque (≈ 0,1 s),
 * para que la animación muestre la deformación progresiva.
 */
function restitution(vnAbs: number, ped: boolean) {
  if (ped) return 0.05;
  // ≈ 0,3 a 10 km/h, ≈ 0,1 a 50 km/h, ≈ 0,05 por encima de 80 km/h (datos de ensayos de choque)
  return Math.max(0.05, Math.min(0.3, 0.35 - 0.0055 * vnAbs * 3.6));
}

interface Impulse {
  J: [number, number];
  /** Energía cinética disipada (J). */
  E: number;
}

function kineticEnergy(m: number, I: number, vx: number, vz: number, w: number) {
  return 0.5 * m * (vx * vx + vz * vz) + 0.5 * I * w * w;
}

/** Impulso sobre B (−J sobre A) en el punto P con normal n de A hacia B. */
function solveImpulse(A: Body, B: Body | null, px: number, pz: number, nx: number, nz: number, eps: number, mu: number): Impulse | null {
  const tx = -nz;
  const tz = nx;
  const rAx = px - A.x;
  const rAz = pz - A.z;
  const rBx = B ? px - B.x : 0;
  const rBz = B ? pz - B.z : 0;
  const [vax, vaz] = A.pointVel(px, pz);
  const [vbx, vbz] = B ? B.pointVel(px, pz) : [0, 0];
  const vrx = vbx - vax;
  const vrz = vbz - vaz;
  const vn = vrx * nx + vrz * nz;
  if (vn >= 0) return null;
  const vt = vrx * tx + vrz * tz;
  // K = Σ (I/m + r⊥ r⊥ᵀ / Iz), r⊥ = (−rz, rx)
  const k = (m: number, I: number, rx: number, rz: number) => {
    const qx = -rz;
    const qz = rx;
    return [1 / m + (qx * qx) / I, (qx * qz) / I, 1 / m + (qz * qz) / I];
  };
  const [a1, b1, c1] = k(A.m, A.Iz, rAx, rAz);
  const [a2, b2, c2] = B ? k(B.m, B.Iz, rBx, rBz) : [0, 0, 0];
  const K11 = a1 + a2;
  const K12 = b1 + b2;
  const K22 = c1 + c2;
  const det = K11 * K22 - K12 * K12;
  const apply = (Jx: number, Jz: number): number => {
    // energía antes − después
    const before = kineticEnergy(A.m, A.Iz, A.vx, A.vz, A.w) + (B ? kineticEnergy(B.m, B.Iz, B.vx, B.vz, B.w) : 0);
    const wa = A.w - (rAx * Jz - rAz * Jx) / A.Iz;
    const after = kineticEnergy(A.m, A.Iz, A.vx - Jx / A.m, A.vz - Jz / A.m, wa) + (B ? kineticEnergy(B.m, B.Iz, B.vx + Jx / B.m, B.vz + Jz / B.m, B.w + (rBx * Jz - rBz * Jx) / B.Iz) : 0);
    return before - after;
  };
  const tryIt = (e: number): Impulse | null => {
    // adherencia: velocidad común en el punto y rebote e en la normal
    const dvx = -(1 + e) * vn * nx - vt * tx;
    const dvz = -(1 + e) * vn * nz - vt * tz;
    let Jx = (K22 * dvx - K12 * dvz) / det;
    let Jz = (-K12 * dvx + K11 * dvz) / det;
    let Jn = Jx * nx + Jz * nz;
    const Jt = Jx * tx + Jz * tz;
    if (!(Jn > 0) || Math.abs(Jt) > mu * Jn) {
      // deslizamiento entre carrocerías: rozamiento opuesto al deslizamiento
      const sg = Math.sign(vt) || 1;
      const dx = nx - mu * sg * tx;
      const dz = nz - mu * sg * tz;
      const den = nx * (K11 * dx + K12 * dz) + nz * (K12 * dx + K22 * dz);
      Jn = den > 1e-9 ? (-(1 + e) * vn) / den : 0;
      Jx = Jn * dx;
      Jz = Jn * dz;
    }
    const E = apply(Jx, Jz);
    return E >= 0 ? { J: [Jx, Jz], E } : null;
  };
  let r = det > 1e-12 ? tryIt(eps) ?? tryIt(0) : null;
  if (!r) {
    // sin rozamiento ni rebote: siempre disipa
    const den = nx * (K11 * nx + K12 * nz) + nz * (K12 * nx + K22 * nz);
    const Jn = -vn / den;
    r = { J: [Jn * nx, Jn * nz], E: Math.max(0, apply(Jn * nx, Jn * nz)) };
  }
  return r;
}

function contactForces(A: Body, B: Body | null, ob: Obstacle | null, st: PairState, t: number, contacts: SimContact[]) {
  const ra = A.rect();
  const rb = B ? B.rect() : obstacleRect(ob!);
  const ca = A.center();
  const cb: [number, number] = B ? B.center() : [ob!.cx, ob!.cz];
  const hit = collide(ra, rb, ca, cb);
  if (hit) {
    st.px = hit.cx;
    st.pz = hit.cz;
    st.quiet = 0;
  }
  // pulso de choque en curso
  if (st.left > 0) {
    if (B) B.applyForce(st.F[0], st.F[1], st.px, st.pz);
    A.applyForce(-st.F[0], -st.F[1], st.px, st.pz);
    st.left--;
    if (st.contact) st.contact.t1 = t;
  }
  if (!hit) {
    if (st.active && st.left <= 0 && ++st.quiet > 20) endContact(A, B, st, t);
    return;
  }
  // zona de solape más profunda durante el pulso de choque (para los daños)
  if (st.left > 0 && st.mainPulse && hit.d >= st.dmax) {
    st.dmax = hit.d;
    st.peakPoly = hit.poly;
    const toLocal = (body: Body, nx: number, nz: number): [Poly, [number, number]] => {
      const [cx, cz] = body.center();
      const [fx, fz] = body.fwd;
      const [rx, rz] = body.right;
      const loc = hit.poly.map(([x, z]) => [(x - cx) * rx + (z - cz) * rz, (x - cx) * fx + (z - cz) * fz] as [number, number]);
      return [loc, [nx * rx + nz * rz, nx * fx + nz * fz]];
    };
    // la normal es la del impacto (la del solape cambia cuando las carrocerías se meten una en otra)
    [st.locA, st.nA] = toLocal(A, st.nx, st.nz);
    if (B) [st.locB, st.nB] = toLocal(B, -st.nx, -st.nz);
  }
  if (st.left > 0) return;
  const [vax, vaz] = A.pointVel(hit.cx, hit.cz);
  const [vbx, vbz] = B ? B.pointVel(hit.cx, hit.cz) : [0, 0];
  const vn = (vbx - vax) * hit.nx + (vbz - vaz) * hit.nz;
  const ped = A.kind === 'ped' || B?.kind === 'ped';
  const mu = ped ? 0.3 : 0.55;
  // tras un impacto las carrocerías quedan encajadas lo que se han aplastado; más allá de eso no
  // pueden atravesarse (al girar juntas, por ejemplo)
  const allowed = st.active ? st.crushA + st.crushB : 0;
  const excess = hit.d - allowed;
  if (st.active && excess > 0.02) {
    const sep = Math.min(excess, 0.004);
    const wA = B ? B.m / (A.m + B.m) : 1;
    A.x -= hit.nx * sep * wA;
    A.z -= hit.nz * sep * wA;
    if (B) {
      B.x += hit.nx * sep * (1 - wA);
      B.z += hit.nz * sep * (1 - wA);
    }
  }
  if (vn > -0.3 || (st.active && excess <= 0)) return;
  // golpe suave dentro de un contacto ya abierto: choque plástico inmediato (sin pulso)
  if (st.active && vn > -2) {
    const imp = solveImpulse(A, B, hit.cx, hit.cz, hit.nx, hit.nz, 0, mu);
    if (!imp) return;
    if (B) {
      B.vx += imp.J[0] / B.m;
      B.vz += imp.J[1] / B.m;
      B.w += ((hit.cx - B.x) * imp.J[1] - (hit.cz - B.z) * imp.J[0]) / B.Iz;
    }
    A.vx -= imp.J[0] / A.m;
    A.vz -= imp.J[1] / A.m;
    A.w -= ((hit.cx - A.x) * imp.J[1] - (hit.cz - A.z) * imp.J[0]) / A.Iz;
    if (st.contact) st.contact.energy += imp.E;
    return;
  }
  // impacto (el primero o uno secundario: p. ej. la trasera que gira y golpea)
  const imp = solveImpulse(A, B, hit.cx, hit.cz, hit.nx, hit.nz, restitution(-vn, ped), mu);
  if (!imp) return;
  const Jm0 = Math.hypot(imp.J[0], imp.J[1]);
  st.mainPulse = Jm0 > st.jMax;
  if (st.mainPulse) {
    // el impacto principal decide la normal de los daños
    st.jMax = Jm0;
    st.nx = hit.nx;
    st.nz = hit.nz;
    st.dmax = 0;
  }
  // reparto de la energía de deformación según la rigidez (muelles en serie)
  const kA = A.stiffness(hit.nx, hit.nz);
  const kB = B ? B.stiffness(-hit.nx, -hit.nz) : ob!.k;
  const shareA = Number.isFinite(kB) ? kB / (kA + kB) : 1;
  // la energía del impacto principal se acumula en su zona; un golpe secundario deforma otra zona
  const eA = imp.E * shareA;
  const eB = imp.E * (1 - shareA);
  if (st.mainPulse || st.eA === 0) {
    st.eA += eA;
    st.eB += eB;
  }
  // ancho de enganche: solape de las dos carrocerías en la dirección perpendicular al golpe
  // (al primer roce solo se tocan las esquinas; lo que se aplasta es todo el solape)
  const tx = -hit.nz;
  const tz = hit.nx;
  const span = (poly: Poly): [number, number] => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, z] of poly) {
      const v = x * tx + z * tz;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return [lo, hi];
  };
  const [a0, a1] = span(ra);
  const [b0, b1] = span(rb);
  const engage = Math.max(hit.width, Math.min(a1, b1) - Math.max(a0, b0));
  const widthRef = B ? Math.min(a1 - a0, b1 - b0) : a1 - a0;
  const wf = Math.max(0.25, Math.min(1, engage / Math.max(0.3, widthRef)));
  const cA0 = st.crushA;
  const cB0 = st.crushB;
  const cAi = Math.sqrt((2 * (st.mainPulse ? st.eA : eA)) / (kA * wf));
  const cBi = B ? Math.sqrt((2 * (st.mainPulse ? st.eB : eB)) / (kB * wf)) : 0;
  st.crushA = Math.min(1.2, Math.max(st.crushA, cAi));
  st.crushB = Math.min(1.2, Math.max(st.crushB, cBi));
  // duración del pulso: la que hace falta para aplastar eso a la velocidad de acercamiento
  // (≈ 0,07–0,12 s en choques de turismos, como en los ensayos)
  const crushNew = st.crushA - cA0 + (st.crushB - cB0);
  const dur = ped ? 0.05 : Math.max(0.04, Math.min(0.15, (2 * Math.max(crushNew, 0.05)) / -vn));
  const n = Math.max(1, Math.round(dur / DT));
  st.F = [imp.J[0] / n / DT, imp.J[1] / n / DT];
  st.left = n;
  const Jm = Math.hypot(imp.J[0], imp.J[1]);
  if (!st.active || !st.contact) {
    st.active = true;
    st.quiet = 0;
    st.contact = {
      a: A.id,
      b: B ? B.id : ob!.id,
      bName: B ? B.e.label || B.e.name : ob!.name,
      t0: t,
      t1: t,
      x: hit.cx,
      z: hit.cz,
      peakForce: 0,
      crushA: 0,
      crushB: 0,
      dvA: 0,
      dvB: 0,
      energy: 0,
    };
    contacts.push(st.contact);
  }
  const c = st.contact;
  // el punto de mayor fuerza es el del impacto principal
  if (Jm / dur > c.peakForce) {
    c.peakForce = Jm / dur;
    c.x = hit.cx;
    c.z = hit.cz;
  }
  c.energy += imp.E;
  c.dvA += Jm / A.m;
  c.dvB += B ? Jm / B.m : 0;
  c.crushA = st.crushA;
  c.crushB = st.crushB;
  for (const body of B ? [A, B] : [A]) {
    if (body.firstContact === null) {
      body.firstContact = t;
      body.impactSpeed = body.speed;
    }
    body.hadContact = true;
    if (body.controlled) body.lostControl = t;
    body.controlled = false;
    body.rested = false;
  }
}

function endContact(_A: Body, _B: Body | null, st: PairState, _t: number) {
  st.active = false;
  st.quiet = 0;
}

/** Zona dañada deducida del solape (en ejes locales: lateral, longitudinal) y la normal hacia fuera. */
function damageFrom(body: Body, loc: Poly, n: [number, number], crush: number, kind: string): DamageZone | null {
  if (crush < 0.02 || loc.length < 3) return null;
  const [nr, nf] = n;
  let side: DamageSide;
  if (Math.abs(nf) >= Math.abs(nr)) side = nf > 0 ? 'frontal' : 'trasera';
  else side = nr > 0 ? 'derecha' : 'izquierda';
  let u0 = Infinity;
  let u1 = -Infinity;
  for (const [lx, lf] of loc) {
    const u = side === 'frontal' || side === 'trasera' ? (lx + body.W / 2) / body.W : (body.L / 2 - lf) / body.L;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
  }
  u0 = Math.max(0, u0 - 0.05);
  u1 = Math.min(1, u1 + 0.05);
  if (u1 - u0 < 0.15) {
    const m = (u0 + u1) / 2;
    u0 = Math.max(0, m - 0.08);
    u1 = Math.min(1, m + 0.08);
  }
  const band: Record<string, [number, number]> = {
    vehiculo: [0.08, 0.68],
    arbol: [0.05, 0.85],
    poste: [0.05, 0.85],
    muro: [0.05, 0.75],
    guardarrail: [0.18, 0.5],
    barrera_hormigon: [0.05, 0.5],
  };
  const [hFrom, hTo] = band[kind] ?? [0.08, 0.7];
  return { id: `auto-${body.id}-${side}-${Math.round(u0 * 100)}`, side, from: u0, to: u1, depth: Math.min(1.2, crush), hFrom, hTo, note: 'Calculado por la simulación' };
}

/** Rejilla espacial de obstáculos (se reutiliza mientras no cambie la lista). */
const GRID_CELL = 8;
const obstacleGrids = new WeakMap<Obstacle[], Map<number, Obstacle[]>>();
const cellKey = (i: number, j: number) => (i + 100_000) * 200_003 + (j + 100_000);
function obstacleGrid(list: Obstacle[]) {
  let g = obstacleGrids.get(list);
  if (g) return g;
  g = new Map();
  for (const o of list) {
    const r = Math.hypot(o.hl, o.hw);
    const i0 = Math.floor((o.cx - r) / GRID_CELL);
    const i1 = Math.floor((o.cx + r) / GRID_CELL);
    const j0 = Math.floor((o.cz - r) / GRID_CELL);
    const j1 = Math.floor((o.cz + r) / GRID_CELL);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const k = cellKey(i, j);
        const arr = g.get(k);
        if (arr) arr.push(o);
        else g.set(k, [o]);
      }
  }
  obstacleGrids.set(list, g);
  return g;
}
function obstaclesNear(grid: Map<number, Obstacle[]>, x: number, z: number, r: number, out: Set<Obstacle>) {
  out.clear();
  const i0 = Math.floor((x - r) / GRID_CELL);
  const i1 = Math.floor((x + r) / GRID_CELL);
  const j0 = Math.floor((z - r) / GRID_CELL);
  const j1 = Math.floor((z + r) / GRID_CELL);
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const arr = grid.get(cellKey(i, j));
      if (arr) for (const o of arr) out.add(o);
    }
  return out;
}
const nearSet = new Set<Obstacle>();

function stepOnce(bodies: Body[], input: SimInput, t: number, pairs: Map<string, PairState>, contacts: SimContact[], record: boolean, collisions: boolean) {
  for (const b of bodies) {
    b.fx = 0;
    b.fz = 0;
    b.tq = 0;
    if (b.rested) continue;
    drive(b, t);
    if (b.kind === 'ped' && !b.hadContact) continue; // cinemático
    tireForces(b, input, record, t);
  }
  if (collisions) {
    for (let i = 0; i < bodies.length; i++) {
      const A = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const B = bodies[j];
        if (A.rested && B.rested) continue;
        const [ax, az] = A.center();
        const [bx, bz] = B.center();
        const r = (Math.hypot(A.L, A.W) + Math.hypot(B.L, B.W)) / 2;
        if ((ax - bx) ** 2 + (az - bz) ** 2 > r * r) {
          const st = pairs.get(A.id + '|' + B.id);
          if (st?.active || (st && st.left > 0)) contactForces(A, B, null, st, t, contacts);
          continue;
        }
        const key = A.id + '|' + B.id;
        let st = pairs.get(key);
        if (!st) pairs.set(key, (st = newPair()));
        contactForces(A, B, null, st, t, contacts);
      }
      if (A.rested && A.kind === 'static') continue;
      const [ax, az] = A.center();
      const rA = Math.hypot(A.L, A.W) / 2;
      for (const o of obstaclesNear(obstacleGrid(input.obstacles), ax, az, rA, nearSet)) {
        const r = rA + Math.hypot(o.hl, o.hw);
        if ((ax - o.cx) ** 2 + (az - o.cz) ** 2 > r * r) continue;
        const key = A.id + '#' + o.id;
        let st = pairs.get(key);
        if (!st) pairs.set(key, (st = newPair()));
        contactForces(A, null, o, st, t, contacts);
      }
    }
  }
  // integración (Euler semiimplícito)
  for (const b of bodies) {
    if (b.kind === 'ped' && !b.hadContact && b.path) {
      // peatón: se desplaza por su ruta a velocidad constante
      const { pedal } = driverState(b.events, t);
      const v = pedal && pedal.action === 'frenar' ? 0 : b.cruise;
      b.ped0 += v * DT;
      const [px, pz] = b.path.point(b.ped0);
      const [tx, tz] = b.path.tangent(b.ped0);
      b.vx = tx * v;
      b.vz = tz * v;
      b.x = px;
      b.z = pz;
      b.psi = Math.atan2(tx, -tz);
      continue;
    }
    if (b.rested) {
      if (Math.hypot(b.fx, b.fz) > 0) b.rested = false;
      else continue;
    }
    const axw = b.fx / b.m;
    const azw = b.fz / b.m;
    b.vx += axw * DT;
    b.vz += azw * DT;
    b.w += (b.tq / b.Iz) * DT;
    b.x += b.vx * DT;
    b.z += b.vz * DT;
    b.psi += b.w * DT;
    const [fx, fz] = b.fwd;
    const [rx, rz] = b.right;
    const ax = axw * fx + azw * fz;
    const ay = axw * rx + azw * rz;
    b.axf += (Math.max(-12, Math.min(12, ax)) - b.axf) * 0.02;
    b.ayf += (Math.max(-12, Math.min(12, ay)) - b.ayf) * 0.02;
    // reposo: muy lento y sin conductor acelerando
    const slow = b.speed < 0.06 && Math.abs(b.w) < 0.03;
    if (slow && (b.hadContact || b.brake > 0.3 || b.kind === 'static') && b.throttle === 0) {
      b.vx = 0;
      b.vz = 0;
      b.w = 0;
      b.rested = true;
      if (b.restTime === null && (b.hadContact || b.kind !== 'static')) b.restTime = t;
    }
  }
}

function recordFrame(b: Body, t: number) {
  const [cx, cz] = b.center();
  b.frames.push({ t, x: cx, z: cz, h: (((b.psi * 180) / Math.PI) % 360 + 360) % 360, v: b.speed, ax: b.axf, ay: b.ayf, steer: b.steer, vx: b.vx, vz: b.vz });
}

/** Simula un vehículo solo (sin choques) para la sincronización: posición del frontal en t = 0 sobre su ruta. */
function frontSAtZero(e: VehicleEntity, input: SimInput, s0: number): number {
  const b = new Body(e);
  // hasta la primera acción del conductor circula a velocidad constante por su ruta: ese tramo se
  // salta (v·t) y solo se simula desde poco antes de la acción
  const first = Math.min(0, ...(e.drive?.events ?? []).map((ev) => ev.t));
  const tA = Math.max(input.start, first - 1.5);
  initBody(b, input, s0 + ((e.drive?.speed ?? 0) / 3.6) * (tA - input.start));
  const bodies = [b];
  const pairs = new Map<string, PairState>();
  for (let t = tA; t < 0 - 1e-9; t += DT) stepOnce(bodies, input, t, pairs, [], false, false);
  const [cx, cz] = b.center();
  const [fx, fz] = b.fwd;
  return b.path!.project(cx + (fx * b.L) / 2, cz + (fz * b.L) / 2);
}

/**
 * Velocidad (m/s) que lleva un vehículo en el instante t si circula solo con su conducción
 * (sin choques). Sirve para pasar de la velocidad en el impacto a la velocidad inicial.
 */
export function soloSpeedAt(e: VehicleEntity, input: SimInput, tEnd = 0): number {
  const b = new Body(e);
  initBody(b, input, 0);
  const bodies = [b];
  const pairs = new Map<string, PairState>();
  // hasta la primera acción sobre los pedales el conductor mantiene la velocidad: empezar justo antes
  const pedals = (e.drive?.events ?? []).filter((ev) => ev.action === 'frenar' || ev.action === 'acelerar' || ev.action === 'soltar').map((ev) => ev.t);
  const t0 = Math.max(input.start, Math.min(tEnd, ...pedals) - 0.5);
  for (let t = t0; t < tEnd - 1e-9; t += DT) {
    stepOnce(bodies, input, t, pairs, [], false, false);
    if (b.rested) return 0;
  }
  return b.speed;
}

/** Resultados de sincronización ya calculados (por suelo: se descartan al cambiar el escenario). */
const syncCaches = new WeakMap<object, Map<string, number>>();

export function simulate(input: SimInput): SimResult {
  const syncOffsets = new Map<string, number>();
  // 1) Sincronización con el punto de colisión
  let cache = syncCaches.get(input.surfaceH);
  if (!cache) syncCaches.set(input.surfaceH, (cache = new Map()));
  for (const e of input.vehicles) {
    const ip = e.drive?.syncPoint ?? input.impact;
    if (!e.drive || !e.drive.sync || !ip || e.drive.path.length < 2) continue;
    const key = JSON.stringify([e.spec, e.drive.path, e.drive.speed, e.drive.abs, e.drive.events, input.start, ip, input.wet]);
    const hit = cache.get(key);
    if (hit !== undefined) {
      syncOffsets.set(e.id, hit);
      continue;
    }
    const path = new Path(e.drive.path);
    const sImp = path.project(ip.x, ip.z);
    let s0 = sImp - (e.drive.speed / 3.6) * Math.max(0, -input.start) - e.spec.L;
    for (let it = 0; it < 5; it++) {
      const sf = frontSAtZero(e, input, s0);
      const err = sImp - sf;
      s0 += err;
      if (Math.abs(err) < 0.02) break;
    }
    syncOffsets.set(e.id, s0);
    if (cache.size > 500) cache.clear();
    cache.set(key, s0);
  }
  // 2) Simulación conjunta
  const bodies = input.vehicles.filter((e) => !e.hidden).map((e) => new Body(e));
  for (const b of bodies) initBody(b, input, syncOffsets.get(b.id) ?? (b.e.drive ? (b.e.drive.startS ?? 0) : null));
  const pairs = new Map<string, PairState>();
  const contacts: SimContact[] = [];
  let step = 0;
  let t = input.start;
  for (const b of bodies) recordFrame(b, t);
  const tEnd = input.end;
  // Posiciones ② del croquis: en t = 0 cada vehículo está exactamente donde se dibujó. La pequeña
  // diferencia que deja el seguimiento de la ruta se reparte suavemente en el segundo y medio previo
  // (equivale a un leve ajuste de la dirección), de modo que el choque empieza en el punto de colisión.
  let snapped = input.start >= 0;
  const corr: { b: Body; n: number; dx: number; dz: number; dh: number }[] = [];
  while (t < tEnd - 1e-9) {
    if (!snapped && t >= -1e-9) {
      snapped = true;
      for (const b of bodies) {
        const cp = b.e.drive?.colPose;
        if (!cp || b.hadContact || (b.kind !== 'car' && b.kind !== 'two')) continue;
        const [cx0, cz0] = b.center();
        const psi = (cp.h * Math.PI) / 180;
        let dpsi = psi - b.psi;
        dpsi = Math.atan2(Math.sin(dpsi), Math.cos(dpsi));
        if (Math.hypot(cp.x - cx0, cp.z - cz0) > 6 || Math.abs(dpsi) > 0.6) continue; // demasiado lejos: no forzar
        const c = Math.cos(dpsi);
        const sn = Math.sin(dpsi);
        [b.vx, b.vz] = [b.vx * c - b.vz * sn, b.vx * sn + b.vz * c];
        b.psi += dpsi;
        const [fx, fz] = b.fwd;
        b.x = cp.x + fx * b.cgAhead;
        b.z = cp.z + fz * b.cgAhead;
        corr.push({ b, n: b.frames.length, dx: cp.x - cx0, dz: cp.z - cz0, dh: (dpsi * 180) / Math.PI });
      }
    }
    stepOnce(bodies, input, t, pairs, contacts, step % 5 === 0, true);
    t += DT;
    step++;
    if (step % REC === 0) {
      for (const b of bodies) recordFrame(b, t);
      // todo en reposo y sin contactos abiertos: ya no cambiará nada (frameAt mantiene el último estado)
      if (t > 0 && bodies.every((b) => b.rested) && ![...pairs.values()].some((st) => st.active)) break;
    }
  }
  // reparto suave de la corrección de la posición ② en los fotogramas y huellas anteriores
  const TB = Math.min(1.5, -input.start);
  const wAt = (tt: number) => {
    if (tt >= -1e-6) return 1;
    const u = Math.max(0, (tt + TB) / TB);
    return u * u * (3 - 2 * u);
  };
  for (const c of corr) {
    for (let i = 0; i < c.n; i++) {
      const f = c.b.frames[i];
      const w = wAt(f.t);
      if (w <= 0) continue;
      f.x += c.dx * w;
      f.z += c.dz * w;
      f.h = (((f.h + c.dh * w) % 360) + 360) % 360;
    }
    for (const m of c.b.marks)
      for (const q of m.pts) {
        if (q.t >= 0) continue;
        const w = wAt(q.t);
        q.x += c.dx * w;
        q.z += c.dz * w;
      }
  }
  // cerrar contactos abiertos
  for (const [key, st] of pairs) {
    if (!st.active) continue;
    const [ia, ib] = key.includes('#') ? key.split('#') : key.split('|');
    const A = bodies.find((b) => b.id === ia)!;
    const B = bodies.find((b) => b.id === ib) ?? null;
    endContact(A, B, st, t);
  }
  // 3) Daños automáticos
  const auto = new Map<string, DamageZone[]>();
  for (const [key, st] of pairs) {
    if (!st.contact || st.peakPoly.length < 3) continue;
    const isOb = key.includes('#');
    const [ia, ib] = isOb ? key.split('#') : key.split('|');
    const A = bodies.find((b) => b.id === ia)!;
    const B = isOb ? null : bodies.find((b) => b.id === ib)!;
    const ob = isOb ? input.obstacles.find((o) => o.id === ib)! : null;
    const zA = damageFrom(A, st.locA, st.nA, st.crushA, B ? 'vehiculo' : ob!.kind);
    if (zA) (auto.get(A.id) ?? auto.set(A.id, []).get(A.id)!).push(zA);
    if (B) {
      const zB = damageFrom(B, st.locB, st.nB, st.crushB, 'vehiculo');
      if (zB) (auto.get(B.id) ?? auto.set(B.id, []).get(B.id)!).push(zB);
    }
  }
  const vehicles = new Map<string, SimVehicle>();
  for (const b of bodies)
    vehicles.set(b.id, {
      id: b.id,
      frames: b.frames,
      marks: b.marks.filter((m) => m.pts.length > 2),
      autoDamage: auto.get(b.id) ?? [],
      firstContact: b.firstContact,
      impactSpeed: b.impactSpeed,
      restTime: b.restTime,
    });
  const firsts = bodies.map((b) => b.firstContact).filter((x): x is number => x !== null);
  return { vehicles, contacts, firstContact: firsts.length ? Math.min(...firsts) : null, start: input.start, end: tEnd, syncOffsets };
}

/** Estado interpolado de un vehículo en el instante t. */
export function frameAt(sv: SimVehicle, t: number): Frame {
  const f = sv.frames;
  if (t <= f[0].t) return f[0];
  if (t >= f[f.length - 1].t) return f[f.length - 1];
  const dt = f[1].t - f[0].t;
  const i = Math.min(f.length - 2, Math.floor((t - f[0].t) / dt));
  const a = f[i];
  const b = f[i + 1];
  const k = (t - a.t) / (b.t - a.t || 1);
  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return {
    t,
    x: a.x + (b.x - a.x) * k,
    z: a.z + (b.z - a.z) * k,
    h: (((a.h + dh * k) % 360) + 360) % 360,
    v: a.v + (b.v - a.v) * k,
    ax: a.ax + (b.ax - a.ax) * k,
    ay: a.ay + (b.ay - a.ay) * k,
    steer: a.steer + (b.steer - a.steer) * k,
    vx: a.vx + (b.vx - a.vx) * k,
    vz: a.vz + (b.vz - a.vz) * k,
  };
}
