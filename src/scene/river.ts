import * as THREE from 'three';
import type { RiverEntity } from '../model/types';
import { GeoBuf } from './geobuf';
import { MAT } from './materials';
import type { PathSample } from './spline';
import type { Corridor } from './terrain';

export function riverCorridor(r: RiverEntity, S: PathSample[]): Corridor {
  const half = r.width / 2;
  return {
    samples: S,
    halfL: half,
    halfR: half,
    talud: r.bank,
    // Cauce parabólico: orillas 25 cm sobre la lámina, fondo a `depth` bajo ella.
    heightAt: (o) => {
      const t = Math.min(1, Math.abs(o) / half);
      return 0.25 - (r.depth + 0.25) * (1 - t * t);
    },
    inset: 0,
  };
}

export function buildRiver(r: RiverEntity, S: PathSample[]): THREE.Group {
  const g = new THREE.Group();
  if (S.length < 2) return g;
  const buf = new GeoBuf();
  const half = r.width / 2 + 0.25;
  buf.strip(S, [-half, 0, half], () => 0, 3);
  const m = buf.mesh(MAT.water, r.id);
  m.receiveShadow = true;
  m.renderOrder = 2;
  g.add(m);
  return g;
}
