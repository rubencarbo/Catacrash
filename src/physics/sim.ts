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
  stiffness() {
    if (this.kind === 'ped') return 4e4;
    if (this.kind === 'two' || TWO_WHEELS.includes(this.e.spec.tipo)) return 2.5e5;
    return 560 * this.m;
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
  active: boolean;
  contact: SimContact | null;
  vA0: [number, number];
  vB0: [number, number];
  quiet: number;
  peakPoly: Poly;
  crushA: number;
  crushB: number;
  /** Normal del contacto en ejes de A (adelante, derecha), fijada al empezar. */
  nLocal: [number, number] | null;
  peakN: [number, number];
  /** Zona de solape y normal hacia fuera en ejes locales de A y B (lateral, longitudinal) en la penetración máxima. */
  locA: Poly;
  locB: Poly;
  nA: [number, number];
  nB: [number, number];
}

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

function contactForces(A: Body, B: Body | null, ob: Obstacle | null, st: PairState, t: number, contacts: SimContact[]) {
  const ra = A.rect();
  const rb = B ? B.rect() : obstacleRect(ob!);
  const ca = A.center();
  const cb: [number, number] = B ? B.center() : [ob!.cx, ob!.cz];
  let axis: [number, number] | undefined;
  if (st.active && st.nLocal) {
    const [fx, fz] = A.fwd;
    const [rx, rz] = A.right;
    axis = [fx * st.nLocal[0] + rx * st.nLocal[1], fz * st.nLocal[0] + rz * st.nLocal[1]];
  }
  const hit = collide(ra, rb, ca, cb, axis);
  if (!hit) {
    if (st.active) {
      st.quiet++;
      if (st.quiet > 20) endContact(A, B, st, t);
    }
    return;
  }
  const kA = A.stiffness();
  const kB = B ? B.stiffness() : ob!.k;
  const kS = Number.isFinite(kB) ? (kA * kB) / (kA + kB) : kA;
  // un obstáculo estrecho (poste, árbol) solo carga una parte del frontal: menos rigidez, más intrusión
  const widthRef = B ? Math.min(A.W, B.W) : A.W;
  const k = kS * Math.max(0.25, Math.min(1, hit.width / widthRef));
  const [vax, vaz] = A.pointVel(hit.cx, hit.cz);
  const [vbx, vbz] = B ? B.pointVel(hit.cx, hit.cz) : [0, 0];
  const rvx = vbx - vax;
  const rvz = vbz - vaz;
  const vn = rvx * hit.nx + rvz * hit.nz; // < 0 se acercan
  const ku = 30 * k;
  let Fn: number;
  const mRed = B ? (A.m * B.m) / (A.m + B.m) : A.m;
  if (hit.d >= st.dmax || vn < 0) {
    st.dmax = Math.max(st.dmax, hit.d);
    Fn = k * hit.d + (vn < 0 ? -vn * 0.3 * Math.sqrt(k * mRed) : 0);
  } else {
    const dp = st.dmax * (1 - k / ku);
    Fn = Math.max(0, ku * (hit.d - dp));
  }
  if (Fn <= 0) return;
  if (!st.active) {
    st.active = true;
    st.quiet = 0;
    st.dmax = 0;
    {
      const [fx, fz] = A.fwd;
      const [rx, rz] = A.right;
      st.nLocal = [hit.nx * fx + hit.nz * fz, hit.nx * rx + hit.nz * rz];
    }
    st.vA0 = [A.vx, A.vz];
    st.vB0 = B ? [B.vx, B.vz] : [0, 0];
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
    for (const body of B ? [A, B] : [A]) {
      if (body.firstContact === null) {
        body.firstContact = t;
        body.impactSpeed = body.speed;
      }
      body.hadContact = true;
      body.controlled = false;
      body.rested = false;
    }
  }
  st.quiet = 0;
  const c = st.contact!;
  if (Fn > 0.03 * c.peakForce) c.t1 = t;
  if (Fn > c.peakForce) {
    c.peakForce = Fn;
    c.x = hit.cx;
    c.z = hit.cz;
  }
  if (hit.d >= st.dmax - 1e-6) {
    st.peakPoly = hit.poly;
    st.peakN = [hit.nx, hit.nz];
    const toLocal = (body: Body, nx: number, nz: number): [Poly, [number, number]] => {
      const [cx, cz] = body.center();
      const [fx, fz] = body.fwd;
      const [rx, rz] = body.right;
      const loc = hit.poly.map(([x, z]) => [(x - cx) * rx + (z - cz) * rz, (x - cx) * fx + (z - cz) * fz] as [number, number]);
      return [loc, [nx * rx + nz * rz, nx * fx + nz * fz]];
    };
    [st.locA, st.nA] = toLocal(A, hit.nx, hit.nz);
    if (B) [st.locB, st.nB] = toLocal(B, -hit.nx, -hit.nz);
  }
  st.crushA = Math.max(st.crushA, (st.dmax * kS) / kA);
  st.crushB = Number.isFinite(kB) ? Math.max(st.crushB, (st.dmax * kS) / kB) : 0;
  c.crushA = st.crushA;
  c.crushB = st.crushB;
  // rozamiento entre carrocerías
  const tvx = rvx - vn * hit.nx;
  const tvz = rvz - vn * hit.nz;
  const tv = Math.hypot(tvx, tvz);
  const mu = 0.5;
  const ft = tv > 1e-6 ? (mu * Fn * Math.min(1, tv / 0.5)) / tv : 0;
  // fuerza sobre B (y la opuesta sobre A)
  const Fbx = Fn * hit.nx - ft * tvx;
  const Fbz = Fn * hit.nz - ft * tvz;
  if (B) B.applyForce(Fbx, Fbz, hit.cx, hit.cz);
  A.applyForce(-Fbx, -Fbz, hit.cx, hit.cz);
  c.energy += Math.abs(Fn * vn * DT) * (vn < 0 ? 1 : -0.2);
}

function endContact(A: Body, B: Body | null, st: PairState, t: number) {
  const c = st.contact;
  if (c) {
    c.dvA = Math.hypot(A.vx - st.vA0[0], A.vz - st.vA0[1]);
    c.dvB = B ? Math.hypot(B.vx - st.vB0[0], B.vz - st.vB0[1]) : 0;
  }
  st.active = false;
  st.quiet = 0;
  st.nLocal = null;
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
          if (st?.active) contactForces(A, B, null, st, t, contacts);
          continue;
        }
        const key = A.id + '|' + B.id;
        let st = pairs.get(key);
        if (!st) pairs.set(key, (st = { dmax: 0, active: false, contact: null, vA0: [0, 0], vB0: [0, 0], quiet: 0, peakPoly: [], crushA: 0, crushB: 0, nLocal: null, peakN: [1, 0], locA: [], locB: [], nA: [0, 1], nB: [0, 1] }));
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
        if (!st) pairs.set(key, (st = { dmax: 0, active: false, contact: null, vA0: [0, 0], vB0: [0, 0], quiet: 0, peakPoly: [], crushA: 0, crushB: 0, nLocal: null, peakN: [1, 0], locA: [], locB: [], nA: [0, 1], nB: [0, 1] }));
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
  while (t < tEnd - 1e-9) {
    stepOnce(bodies, input, t, pairs, contacts, step % 5 === 0, true);
    t += DT;
    step++;
    if (step % REC === 0) {
      for (const b of bodies) recordFrame(b, t);
      // todo en reposo y sin contactos abiertos: ya no cambiará nada (frameAt mantiene el último estado)
      if (t > 0 && bodies.every((b) => b.rested) && ![...pairs.values()].some((st) => st.active)) break;
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
