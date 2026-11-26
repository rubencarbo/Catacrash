// Ajuste automático: recupera velocidades y frenada a partir de las posiciones finales y la huella
// (npx tsx tests/fit.test.ts)
import { candidateParams, fit, skidLength, type FitProblem } from '../src/physics/fit';
import { simulate, type SimInput } from '../src/physics/sim';
import { genericSpec } from '../src/vehicles/spec';
import type { Drive, VehicleEntity } from '../src/model/types';

const car = (id: string, x: number, z: number, heading: number, drive: Drive, tipo: 'compacto' | 'suv' = 'compacto'): VehicleEntity => ({
  id, kind: 'vehicle', name: id, label: id, spec: genericSpec(tipo), x, z, heading, color: '#f00', plate: '', occupants: 1, cargo: 0, damage: [], photos: [], drive,
});
const line = (z0: number, z1: number, x = 0) => [{ x, z: z0, h: null }, { x, z: z1, h: null }];
let fails = 0;
const check = (name: string, val: number, lo: number, hi: number, unit = '') => {
  const ok = val >= lo && val <= hi;
  if (!ok) fails++;
  console.log(`${ok ? '✔' : '✘'} ${name}: ${val.toFixed(2)}${unit} (esperado ${lo}–${hi})`);
};

// «Hechos»: A (compacto) a 75 km/h; B (SUV) a 55 km/h frena sin ABS 0,7 s antes del choque.
const truth = (vA: number, vB: number, tB: number) => [
  car('A', 0, 0, 180, { path: line(-200, 200, 0), speed: vA, sync: true, abs: true, events: [] }),
  car('B', 1.2, 0, 0, { path: line(200, -200, 1.2), speed: vB, sync: true, abs: false, events: [{ id: 'fb', t: tB, action: 'frenar', value: 1 }] }, 'suv'),
];
const input = (vehicles: VehicleEntity[]): SimInput => ({
  vehicles, start: -4, end: 8, impact: { x: 0.6, z: 0 }, wet: false, surfaceH: () => 0, surfaceKind: () => 'asfalto', obstacles: [],
});
const real = simulate(input(truth(75, 55, -0.7)));
const finalOf = (id: string) => {
  const f = real.vehicles.get(id)!.frames.at(-1)!;
  return { x: f.x, z: f.z, h: f.h };
};
const skidB = skidLength(real, 'B');
console.log(`Hechos simulados: A final (${finalOf('A').x.toFixed(1)}, ${finalOf('A').z.toFixed(1)}), B final (${finalOf('B').x.toFixed(1)}, ${finalOf('B').z.toFixed(1)}), huella de B ${skidB.toFixed(1)} m`);

// Punto de partida erróneo: A 50, B 85, frenada en −2 s
const guess = truth(50, 85, -2);
const params = guess.flatMap((v) => candidateParams(v)).filter((p) => p.kind !== 'evV');
const pb: FitProblem = {
  input: input(guess),
  params,
  targets: [
    { veh: 'A', final: finalOf('A'), crush: null, skid: null },
    { veh: 'B', final: finalOf('B'), crush: null, skid: Math.round(skidB * 2) / 2 },
  ],
};
const t0 = Date.now();
fit(pb, { onProgress: () => {} }).then((r) => {
  const ms = Date.now() - t0;
  console.log(`Ajuste: ${r.evals} simulaciones en ${(ms / 1000).toFixed(1)} s, coste ${r.initial.cost.toFixed(1)} → ${r.best.cost.toFixed(2)}`);
  params.forEach((p, i) => console.log(`   ${p.veh} ${p.label}: ${p.value} → ${r.best.x[i].toFixed(2)} ${p.unit} (rango ${r.ranges[i][0].toFixed(1)}–${r.ranges[i][1].toFixed(1)})`));
  const eA = r.best.errors.find((e) => e.veh === 'A')!;
  const eB = r.best.errors.find((e) => e.veh === 'B')!;
  check('Error de posición final A', eA.dist!, 0, 1.0, ' m');
  check('Error de posición final B', eB.dist!, 0, 1.0, ' m');
  check('Error de huella B', Math.abs(eB.skidSim! - eB.skidObs!), 0, 1.5, ' m');
  check('Velocidad de A recuperada', r.best.x[0], 65, 85, ' km/h');
  check('Velocidad de B recuperada', r.best.x[1], 45, 65, ' km/h');
  check('El rango de A contiene el valor real', r.ranges[0][0] <= 75 && r.ranges[0][1] >= 75 ? 1 : 0, 1, 1);
  console.log(fails ? `\n${fails} comprobación(es) fuera de rango` : '\nAjuste correcto');
  process.exit(fails ? 1 : 0);
});
