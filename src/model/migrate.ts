import type { CtrlPoint, MotionKey, Project, VehicleEntity } from './types';

/** Versión actual del formato de proyecto. */
export const PROJECT_VERSION = 2;

/** Nombre del escenario de ejemplo (para reconocer copias antiguas guardadas en el navegador). */
export const DEMO_NAME = 'Ejemplo: colisión frontal en curva';

/** ¿Es una copia guardada de un ejemplo anterior a la simulación física? */
export function isStaleDemo(p: Project): boolean {
  return (p.version ?? 1) < PROJECT_VERSION && p.name === DEMO_NAME;
}

/**
 * Pone al día un proyecto guardado con versiones anteriores. Las trayectorias por claves
 * (animación antigua) se convierten en conducción simulada: la ruta pasa por las claves y la
 * velocidad inicial es la de la primera clave (o la deducida del primer tramo).
 * Devuelve cuántos vehículos se han convertido.
 */
export function migrateProject(p: Project): number {
  let converted = 0;
  const start = p.timeline?.start ?? -4;
  for (const e of p.entities) {
    if (e.kind !== 'vehicle') continue;
    const v = e as VehicleEntity & { motion?: MotionKey[] };
    if (!v.drive && v.motion && v.motion.length >= 2) {
      const keys = [...v.motion].sort((a, b) => a.t - b.t);
      const k0 = keys[0];
      const k1 = keys[1];
      const seg = Math.hypot(k1.x - k0.x, k1.z - k0.z);
      const kmh = k0.speed ?? (k1.t > k0.t ? (seg / (k1.t - k0.t)) * 3.6 : 50);
      const path: CtrlPoint[] = keys.map((k) => ({ x: k.x, z: k.z, h: null }));
      // la simulación arranca al principio de la ruta en el instante inicial: alargarla hacia atrás
      const back = (kmh / 3.6) * Math.max(0, k0.t - start);
      if (back > 0.5 && seg > 1e-3) {
        const ux = (k1.x - k0.x) / seg;
        const uz = (k1.z - k0.z) / seg;
        path.unshift({ x: k0.x - ux * back, z: k0.z - uz * back, h: null });
      }
      const stops = keys.some((k) => k.marks);
      v.drive = {
        path,
        speed: Math.round(kmh),
        sync: false,
        abs: !stops,
        events: [],
        showFinal: true,
      };
      // la posición del vehículo pasa a ser la final observada
      const last = keys[keys.length - 1];
      v.x = last.x;
      v.z = last.z;
      if (last.heading != null) v.heading = last.heading;
      converted++;
    }
    delete v.motion;
  }
  p.version = PROJECT_VERSION;
  return converted;
}
