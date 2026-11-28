// Pruebas de plausibilidad física del motor (npx tsx tests/physics.test.ts)
import { simulate, frameAt, type SimInput } from '../src/physics/sim';
import { genericSpec } from '../src/vehicles/spec';
import type { VehicleEntity, Drive } from '../src/model/types';

const car = (id: string, x: number, z: number, heading: number, drive?: Drive, tipo: 'compacto' | 'suv' = 'compacto'): VehicleEntity => ({
  id, kind: 'vehicle', name: id, label: id, spec: genericSpec(tipo), x, z, heading, color: '#f00', plate: '', occupants: 1, cargo: 0, damage: [], photos: [], drive,
});
const base = (vehicles: VehicleEntity[], extra: Partial<SimInput> = {}): SimInput => ({
  vehicles, start: -4, end: 4, impact: null, wet: false, surfaceH: () => 0, surfaceKind: () => 'asfalto', obstacles: [], ...extra,
});
const line = (z0: number, z1: number, x = 0) => [{ x, z: z0, h: null }, { x, z: z1, h: null }];
let fails = 0;
const check = (name: string, val: number, lo: number, hi: number, unit = '') => {
  const ok = val >= lo && val <= hi;
  if (!ok) fails++;
  console.log(`${ok ? '✔' : '✘'} ${name}: ${val.toFixed(2)}${unit} (esperado ${lo}–${hi})`);
};

// 1) Frenada de emergencia con ABS desde 50 km/h en seco: d ≈ v²/(2·μ·g) ≈ 12–13 m
{
  const r = simulate(base([car('A', 0, 0, 180, { path: line(-200, 200), speed: 50, sync: false, abs: true, events: [{ id: 'e', t: 0, action: 'frenar', value: 1 }] })]));
  const sv = r.vehicles.get('A')!;
  const p0 = frameAt(sv, 0);
  const pend = sv.frames[sv.frames.length - 1];
  check('Distancia de frenada 50 km/h (ABS, seco)', Math.hypot(pend.x - p0.x, pend.z - p0.z), 11, 14.5, ' m');
  check('Tiempo hasta parar', (sv.restTime ?? 99) - 0, 1.5, 2.1, ' s');
}
// 2) Con firme mojado la distancia aumenta
{
  const r = simulate(base([car('A', 0, 0, 180, { path: line(-200, 200), speed: 50, sync: false, abs: true, events: [{ id: 'e', t: 0, action: 'frenar', value: 1 }] })], { wet: true }));
  const sv = r.vehicles.get('A')!;
  const p0 = frameAt(sv, 0);
  const pend = sv.frames[sv.frames.length - 1];
  check('Distancia de frenada 50 km/h (mojado)', Math.hypot(pend.x - p0.x, pend.z - p0.z), 17, 23, ' m');
}
// 3) Crucero: mantiene la velocidad
{
  const r = simulate(base([car('A', 0, 0, 180, { path: line(-200, 200), speed: 90, sync: false, abs: true, events: [] })]));
  check('Velocidad de crucero a 90 km/h tras 6 s', frameAt(r.vehicles.get('A')!, 2).v * 3.6, 87, 92, ' km/h');
}
// 4) Choque contra muro rígido a 50 km/h: aplastamiento ≈ 0,4–0,7 m, duración ≈ 0,07–0,15 s
{
  const wall = { id: 'm', name: 'Muro', cx: 0, cz: 10, hl: 5, hw: 0.2, ang: 0, k: Infinity, kind: 'muro' };
  const r = simulate(base([car('A', 0, 0, 180, { path: line(-20, 100), speed: 50, sync: false, abs: true, events: [] })], { obstacles: [wall], start: -1 }));
  const c = r.contacts[0];
  check('Muro: aplastamiento', c?.crushA ?? 0, 0.35, 0.75, ' m');
  check('Muro: duración del contacto', c ? c.t1 - c.t0 : 0, 0.05, 0.2, ' s');
  check('Muro: Δv (≈ 50 km/h + rebote pequeño)', (c?.dvA ?? 0) * 3.6, 50, 62, ' km/h');
}
// 5) Frontal entre dos turismos iguales a 50 km/h con solape del 50 %: conservación del momento
{
  const A = car('A', 0, 0, 180, { path: line(-200, 200, 0), speed: 50, sync: true, abs: true, events: [] });
  const B = car('B', 0.9, 0, 0, { path: line(200, -200, 0.9), speed: 50, sync: true, abs: true, events: [] });
  const r = simulate(base([A, B], { impact: { x: 0.45, z: 0 } }));
  const c = r.contacts.find((c) => c.b === 'B' || c.a === 'B');
  check('Frontal: hay contacto cerca de t = 0', c ? c.t0 : 99, -0.25, 0.05, ' s');
  check('Frontal: Δv de A (≈ 50 km/h)', (c?.dvA ?? 0) * 3.6, 40, 62, ' km/h');
  check('Frontal: Δv iguales (masas iguales)', Math.abs((c?.dvA ?? 0) - (c?.dvB ?? 9)) * 3.6, 0, 6, ' km/h');
  const fa = frameAt(r.vehicles.get('A')!, 0.4);
  const fb = frameAt(r.vehicles.get('B')!, 0.4);
  check('Frontal: velocidades tras el choque bajas', Math.max(fa.v, fb.v) * 3.6, 0, 20, ' km/h');
  check('Frontal: los vehículos giran (rumbo A cambia)', Math.abs(((frameAt(r.vehicles.get('A')!, 1.5).h - 180 + 540) % 360) - 180), 5, 120, '°');
  check('Daño automático en el frontal de A', (r.vehicles.get('A')!.autoDamage.find((z) => z.side === 'frontal')?.depth ?? 0), 0.15, 0.7, ' m');
}
// 6) Curva de 50 m de radio a 60 km/h: la sigue sin salirse (a_y ≈ 5,6 m/s²)
{
  const pts = [] as { x: number; z: number; h: null }[];
  for (let a = 0; a <= Math.PI; a += 0.1) pts.push({ x: 50 - 50 * Math.cos(a), z: -50 * Math.sin(a), h: null });
  const pre = [{ x: 0, z: 120, h: null }, { x: 0, z: 60, h: null }, ...pts.map((p) => ({ ...p, z: p.z }))];
  const r = simulate(base([car('A', 0, 0, 0, { path: pre, speed: 60, sync: false, abs: true, events: [] })], { start: 0, end: 10 }));
  const sv = r.vehicles.get('A')!;
  let maxErr = 0;
  for (const f of sv.frames) {
    if (f.t < 4 || f.t > 8) continue;
    const d = Math.abs(Math.hypot(f.x - 50, f.z) - 50);
    if (f.z < 0) maxErr = Math.max(maxErr, d);
  }
  check('Curva R=50 m a 60 km/h: desviación máxima de la trazada', maxErr, 0, 1.2, ' m');
}
// 7) Frenada sin ABS: ruedas bloqueadas dejan huella
{
  const r = simulate(base([car('A', 0, 0, 180, { path: line(-200, 200), speed: 60, sync: false, abs: false, events: [{ id: 'e', t: 0, action: 'frenar', value: 1 }] })]));
  const marks = r.vehicles.get('A')!.marks;
  const len = marks.reduce((s, m) => s + Math.hypot(m.pts[m.pts.length - 1].x - m.pts[0].x, m.pts[m.pts.length - 1].z - m.pts[0].z), 0) / Math.max(1, marks.length);
  check('Sin ABS: longitud de huella por rueda (≈ v²/2μg ≈ 18 m)', len, 14, 22, ' m');
}
// 8) Masas distintas (SUV contra compacto): se conserva la cantidad de movimiento total
{
  const A = car('A', 0, 0, 180, { path: line(-200, 200, 0), speed: 60, sync: true, abs: true, events: [] }, 'suv_grande' as 'suv');
  const B = car('B', 0, 0, 0, { path: line(200, -200, 0.3), speed: 40, sync: true, abs: true, events: [] });
  const r = simulate(base([A, B], { impact: { x: 0.15, z: 0 }, start: -2, end: 2 }));
  const c = r.contacts.find((c) => c.b === 'B')!;
  const sa = r.vehicles.get('A')!;
  const sb = r.vehicles.get('B')!;
  const mA = A.spec.masa;
  const mB = B.spec.masa;
  const pz = (t: number) => {
    const fa = frameAt(sa, t);
    const fb = frameAt(sb, t);
    return mA * fa.vz + mB * fb.vz;
  };
  const before = pz(c.t0 - 0.02);
  const after = pz(c.t1 + 0.01);
  check('Momento lineal conservado en el choque (error relativo)', Math.abs(after - before) / Math.abs(before), 0, 0.12, '');
  check('El vehículo ligero sufre mayor Δv', (c.dvB - c.dvA) * 3.6, 5, 80, ' km/h');
}
// 9) Choque lateral en T: daño en el costado derecho del golpeado y giro
{
  const A = car('A', 0, 0, 90, { path: [{ x: -60, z: 0, h: null }, { x: 60, z: 0, h: null }], speed: 50, sync: true, abs: true, events: [] });
  const B = car('B', 0, 0, 0, { path: line(60, -60, 2.5), speed: 30, sync: true, abs: true, events: [] });
  const r = simulate(base([A, B], { impact: { x: 2.0, z: 0.6 }, start: -2, end: 3 }));
  const zb = r.vehicles.get('B')!.autoDamage;
  check('Lateral: B tiene daño en el costado izquierdo (lado del golpe)', zb.some((z) => z.side === 'izquierda') ? 1 : 0, 1, 1);
  const hb = frameAt(r.vehicles.get('B')!, 2.5).h;
  check('Lateral: B gira tras el impacto', Math.abs(((hb - 0 + 540) % 360) - 180), 8, 180, '°');
}
// 10) Poste: impacto estrecho y profundo
{
  const pole = { id: 'p', name: 'Poste', cx: 0.2, cz: 10, hl: 0.12, hw: 0.12, ang: 0, k: 2e6, kind: 'poste' };
  const r = simulate(base([car('A', 0, 0, 180, { path: line(-20, 100), speed: 50, sync: false, abs: true, events: [] })], { obstacles: [pole], start: -1 }));
  const z = r.vehicles.get('A')!.autoDamage.find((d) => d.side === 'frontal');
  check('Poste: aplastamiento mayor que contra el muro', r.contacts[0]?.crushA ?? 0, 0.55, 1.2, ' m');
  check('Poste: zona dañada estrecha', z ? z.to - z.from : 1, 0, 0.35, '');
}
// 9) Choque en ángulo recto en un cruce (A a 60 km/h hacia el este, B a 30 km/h hacia el norte):
//    la energía cinética solo puede disminuir, ninguno sale más rápido de lo que iba el más rápido,
//    los giros quedan acotados y ambos se detienen en pocos segundos.
{
  const lineX = (x0: number, x1: number, z: number) => [{ x: x0, z, h: null }, { x: x1, z, h: null }];
  const A = car('A', 0, -1.2, 90, { path: lineX(-200, 200, -1.2), speed: 60, sync: true, abs: true, events: [], syncPoint: { x: 0.2, z: -1.2 } });
  const B = car('B', 1.2, 0, 0, { path: [{ x: 1.2, z: 200, h: null }, { x: 1.2, z: -200, h: null }], speed: 30, sync: true, abs: true, events: [], syncPoint: { x: 1.2, z: -0.2 } });
  const r = simulate(base([A, B], { end: 8 }));
  const KE = (t: number) => ['A', 'B'].reduce((s, id) => s + 0.5 * 1300 * frameAt(r.vehicles.get(id)!, t).v ** 2, 0);
  const c = r.contacts[0];
  const t0 = c?.t0 ?? 0;
  check('Cruce: hay choque', c ? 1 : 0, 1, 1);
  check('Cruce: energía de traslación tras el choque / antes', KE(t0 + 0.2) / KE(t0 - 0.02), 0, 0.85);
  const vmax = Math.max(...['A', 'B'].map((id) => Math.max(...r.vehicles.get(id)!.frames.filter((f) => f.t > t0 + 0.05).map((f) => f.v)))) * 3.6;
  check('Cruce: nadie sale más rápido que antes del choque', vmax, 0, 60);
  const rot = (id: string) => {
    const fr = r.vehicles.get(id)!.frames.filter((f) => f.t >= t0);
    let s = 0;
    for (let i = 1; i < fr.length; i++) s += Math.abs(((fr[i].h - fr[i - 1].h + 540) % 360) - 180);
    return s;
  };
  check('Cruce: giro total de B tras el choque', rot('B'), 10, 360, '°');
  check('Cruce: giro total de A tras el choque', rot('A'), 0, 270, '°');
  check('Cruce: ambos se detienen (s tras el choque)', Math.max(r.vehicles.get('A')!.restTime ?? 99, r.vehicles.get('B')!.restTime ?? 99) - t0, 0.5, 5, ' s');
  check('Cruce: energía disipada en deformación', (c?.energy ?? 0) / 1000, 40, 220, ' kJ');
}
console.log(fails ? `\n${fails} comprobaciones fuera de rango` : '\nTodo dentro de rango');
process.exit(fails ? 1 : 0);
