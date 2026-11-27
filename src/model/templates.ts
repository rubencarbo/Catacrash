import { emptyProject, ROAD_PRESETS } from './defaults';
import { newId } from './store';
import type { CtrlPoint, Entity, Project, RoadEntity, RoundaboutEntity } from './types';

/**
 * Plantillas para empezar un escenario en segundos: una carretera recta, una curva, cruces o
 * una glorieta, con el tipo de vía elegido. Después todo se puede editar.
 */
export type TemplateId = 'recta' | 'curva' | 'cruceT' | 'cruceX' | 'glorieta' | 'vacio';
export type RoadKind = 'convencional' | 'secundaria' | 'urbana' | 'camino';

export const TEMPLATES: { id: TemplateId; label: string; desc: string; svg: string }[] = [
  { id: 'recta', label: 'Recta', desc: 'Tramo recto de 300 m', svg: '<path d="M30 4v52" stroke-width="9"/><path d="M30 6v48" class="mk" stroke-dasharray="5 5"/>' },
  { id: 'curva', label: 'Curva', desc: 'Curva de radio 90 m', svg: '<path d="M8 56C8 30 26 10 56 8" stroke-width="9" fill="none"/><path d="M8 54C9 30 27 11 54 8" class="mk" stroke-dasharray="5 5" fill="none"/>' },
  { id: 'cruceT', label: 'Cruce en T', desc: 'Vía principal y una secundaria', svg: '<path d="M30 4v52M30 30h28" stroke-width="9"/><path d="M30 6v48" class="mk" stroke-dasharray="5 5"/>' },
  { id: 'cruceX', label: 'Cruce en X', desc: 'Dos vías que se cruzan', svg: '<path d="M30 4v52M4 30h52" stroke-width="9"/><path d="M30 6v48" class="mk" stroke-dasharray="5 5"/>' },
  { id: 'glorieta', label: 'Glorieta', desc: 'Glorieta con cuatro accesos', svg: '<circle cx="30" cy="30" r="13" stroke-width="7" fill="none"/><path d="M30 4v13M30 43v13M4 30h13M43 30h13" stroke-width="7"/>' },
  { id: 'vacio', label: 'Terreno vacío', desc: 'Dibujas tú la carretera', svg: '<rect x="8" y="8" width="44" height="44" rx="4" stroke-width="2" stroke-dasharray="4 4" fill="none"/>' },
];

export const ROAD_KINDS: { id: RoadKind; label: string; preset: string }[] = [
  { id: 'convencional', label: 'Carretera convencional (1+1 con arcén)', preset: 'convencional' },
  { id: 'secundaria', label: 'Carretera secundaria estrecha', preset: 'secundaria' },
  { id: 'urbana', label: 'Calle urbana con aceras', preset: 'urbana' },
  { id: 'camino', label: 'Camino de tierra', preset: 'camino' },
];

const P = (x: number, z: number): CtrlPoint => ({ x, z, h: null });
const line = (x0: number, z0: number, x1: number, z1: number, n = 6) => Array.from({ length: n + 1 }, (_, i) => P(x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n));

export function templateProject(id: TemplateId, kind: RoadKind, name: string): Project {
  const p = emptyProject();
  p.name = name || 'Escenario sin título';
  const preset = ROAD_KINDS.find((k) => k.id === kind)?.preset ?? 'convencional';
  const limit = kind === 'urbana' ? 50 : kind === 'camino' ? 30 : kind === 'secundaria' ? 70 : 90;
  const road = (nm: string, points: CtrlPoint[], priority = 1, pr = preset): RoadEntity => ({
    id: newId('r'),
    kind: 'road',
    name: nm,
    points,
    profile: (ROAD_PRESETS[pr] ?? ROAD_PRESETS.convencional).make(),
    priority,
    limit,
  });
  const E: Entity[] = [];
  const minor = kind === 'convencional' ? 'secundaria' : preset;
  switch (id) {
    case 'recta':
      E.push(road('Carretera', line(0, -150, 0, 150)));
      break;
    case 'curva': {
      // recta hacia el sur, curva de 90 m de radio y recta hacia el este
      const pts: CtrlPoint[] = [P(-90, -150), P(-90, -105)];
      for (let a = 180; a >= 90; a -= 15) {
        const r = (a * Math.PI) / 180;
        pts.push(P(Math.cos(r) * 90, -60 + Math.sin(r) * 90));
      }
      pts.push(P(45, 30), P(150, 30));
      E.push(road('Carretera', pts));
      break;
    }
    case 'cruceT':
      E.push(road('Vía principal', line(0, -150, 0, 150), 2), road('Vía secundaria', line(0, 0, 150, 0, 5), 0, minor));
      break;
    case 'cruceX':
      E.push(road('Vía principal', line(0, -150, 0, 150), 2), road('Vía secundaria', line(-150, 0, 150, 0), 0, minor));
      break;
    case 'glorieta': {
      const rb: RoundaboutEntity = {
        id: newId('g'),
        kind: 'roundabout',
        name: 'Glorieta',
        cx: 0,
        cz: 0,
        h: null,
        radius: 20,
        width: 8,
        lanes: 1,
        apron: 1.5,
        island: 'hierba',
        outer: 'arcen',
        outerWidth: 1,
        talud: 4,
      };
      E.push(rb);
      const r0 = 18;
      E.push(
        road('Acceso norte', line(0, -r0, 0, -150, 4)),
        road('Acceso sur', line(0, r0, 0, 150, 4)),
        road('Acceso este', line(r0, 0, 150, 0, 4)),
        road('Acceso oeste', line(-r0, 0, -150, 0, 4)),
      );
      break;
    }
    case 'vacio':
      break;
  }
  p.entities = E;
  return p;
}
