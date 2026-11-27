import type { Editor } from '../editor';
import type { RoadEntity, VehicleEntity } from '../model/types';
import { laneRoute } from '../physics/lane';
import { roadHeadings } from '../tools/dial';
import { toast } from './dom';

/**
 * Acciones de alto nivel que hacen el trabajo por el usuario (barra contextual y pasos guiados).
 */

const roadsOf = (ed: Editor) => ed.store.project.entities.filter((x): x is RoadEntity => x.kind === 'road');

/** Da movimiento a un vehículo parado: ruta por su carril y una velocidad habitual. */
export function giveMotion(ed: Editor, e: VehicleEntity, edit = true) {
  if (e.drive) return;
  const apply = () => {
    e.drive = {
      path: laneRoute(ed.world, roadsOf(ed), e.x, e.z, e.heading),
      speed: e.spec.tipo === 'peaton' ? 5 : 50,
      sync: !!ed.store.project.impact,
      abs: true,
      events: [],
      showFinal: false,
    };
  };
  if (edit) ed.store.edit(apply, { type: 'env' });
  else apply();
}

/** Da movimiento a todos los vehículos que aún no lo tienen (una sola acción deshacible). */
export function giveMotionAll(ed: Editor) {
  const list = ed.store.project.entities.filter((x): x is VehicleEntity => x.kind === 'vehicle' && !x.drive && !x.hidden);
  if (!list.length) return toast('Todos los vehículos tienen ya movimiento.');
  ed.store.edit(() => list.forEach((v) => giveMotion(ed, v, false)), { type: 'env' });
  toast(`${list.map((v) => v.label).join(', ')}: ruta por su carril a ${list[0].spec.tipo === 'peaton' ? 5 : 50} km/h. Ajusta las velocidades en el inspector o con «Ajustar a los hechos».`);
}

/** Gira el vehículo u objeto para alinearlo con la vía (en el sentido más parecido al actual). */
export function alignToRoad(ed: Editor, id: string) {
  const pose = ed.currentPose(id);
  if (!pose) return;
  const hs = roadHeadings(ed.world, pose.x, pose.z, 20);
  if (!hs.length) return toast('No hay ninguna carretera cerca para alinearlo.', 'error');
  const diff = (a: number) => Math.abs(((a - pose.h + 540) % 360) - 180);
  const h = hs.reduce((b, x) => (diff(x) < diff(b) ? x : b), hs[0]);
  ed.setPose(id, { ...pose, h });
}

/** Gira el vehículo u objeto un ángulo (grados, + horario). */
export function rotateBy(ed: Editor, id: string, deg: number) {
  const pose = ed.currentPose(id);
  if (pose) ed.setPose(id, { ...pose, h: (pose.h + deg + 360) % 360 });
}

/**
 * Marca el punto de colisión con el próximo clic y hace que los vehículos con movimiento lleguen
 * a él a la vez (t = 0): el choque queda planteado en un solo paso.
 */
export function markImpact(ed: Editor) {
  ed.setTool('select');
  ed.setHint?.('Haz clic en el punto de colisión (la X del croquis)');
  toast('Haz clic en la escena donde chocaron (la X del croquis).');
  ed.pickOnce = (p) => {
    ed.store.edit(
      () => {
        ed.store.project.impact = { x: p.x, z: p.z };
        for (const v of ed.store.project.entities) if (v.kind === 'vehicle' && v.drive) v.drive.sync = true;
      },
      { type: 'env' },
    );
    ed.player?.setTime(0);
    toast('Punto de colisión fijado: los vehículos con movimiento llegan a él en t = 0.');
  };
}
