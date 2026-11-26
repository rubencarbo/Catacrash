import * as THREE from 'three';
import type { Editor, Tool } from '../editor';
import { newId } from '../model/store';
import type { OverlayEntity } from '../model/types';
import { loadPnoa } from '../io/geo';
import { h, fmt, toast } from '../ui/dom';
import { ICON } from '../ui/icons';
import { pickEntity } from './basic';

/** Lee una imagen, la reduce si es enorme y opcionalmente vuelve transparente el fondo blanco. */
export async function readImage(file: Blob, removeWhite: boolean): Promise<{ url: string; aspect: number }> {
  const src = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('No se pudo leer la imagen'));
    i.src = src;
  });
  const max = 4096;
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * k);
  c.height = Math.round(img.height * k);
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0, c.width, c.height);
  if (removeWhite) {
    const d = g.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const lum = Math.min(d.data[i], d.data[i + 1], d.data[i + 2]);
      const a = Math.max(0, Math.min(255, (235 - lum) * 2.2));
      d.data[i + 3] = a;
      // oscurecer trazos para que contrasten sobre el terreno
      d.data[i] *= 0.6;
      d.data[i + 1] *= 0.6;
      d.data[i + 2] *= 0.6;
    }
    g.putImageData(d, 0, 0);
    return { url: c.toDataURL('image/png'), aspect: c.height / c.width };
  }
  return { url: c.toDataURL('image/jpeg', 0.9), aspect: c.height / c.width };
}

export function addOverlay(ed: Editor, url: string, aspect: number, name: string, width = 100, cx?: number, cz?: number) {
  const asset = newId('img');
  ed.store.assets.set(asset, url);
  const t = ed.vp.controls.target;
  const o: OverlayEntity = {
    id: newId('o'),
    kind: 'overlay',
    name,
    asset,
    cx: cx ?? t.x,
    cz: cz ?? t.z,
    width,
    aspect,
    rot: 0,
    opacity: 0.85,
    onRoads: false,
  };
  ed.store.add(o);
  ed.select(o.id);
  return o;
}

/**
 * Calcos: croquis manuscrito, captura de mapa o ortofoto del IGN proyectados sobre el terreno.
 * Incluye calibración de escala midiendo una distancia conocida.
 */
export function overlayTool(ed: Editor): Tool {
  let calib: { id: string; a: THREE.Vector3 | null; b: THREE.Vector3 | null } | null = null;
  let removeWhite = true;
  const pnoa = { lat: ed.store.project.geo?.lat ?? 40.4168, lon: ed.store.project.geo?.lon ?? -3.7038, size: ed.store.project.terrain.size };
  const markers = new THREE.Group();
  ed.vp.scene.add(markers);
  const dot = (p: THREE.Vector3) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.4, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff3d3d, depthTest: false }));
    m.position.copy(p);
    m.renderOrder = 12;
    markers.add(m);
  };
  const stopCalib = () => {
    calib = null;
    markers.clear();
    ed.refreshOptions?.();
  };

  const tool: Tool = {
    id: 'overlay',
    label: 'Calcos: croquis, capturas y ortofoto',
    icon: ICON.overlay,
    key: 'k',
    handles: true,
    hint: 'Clic: seleccionar calco · Arrastra el centro para moverlo y las esquinas para escalar/girar (Mayús: solo escalar)',
    deactivate() {
      if (calib) stopCalib();
    },
    click(ev) {
      if (calib) {
        if (!ev.ground) return;
        if (!calib.a) calib.a = ev.ground.clone();
        else if (!calib.b) calib.b = ev.ground.clone();
        dot(ev.ground);
        ed.refreshOptions?.();
        return;
      }
      ed.select(pickEntity(ed, ev));
    },
    onKey(e) {
      if (e.key === 'Escape' && calib) {
        stopCalib();
        return true;
      }
      return false;
    },
    options(el) {
      const sel = ed.store.selection && ed.store.get(ed.store.selection.id);
      if (calib) {
        const o = ed.store.get(calib.id) as OverlayEntity | undefined;
        el.append(h('div', { class: 'cat-title' }, 'Calibrar escala'));
        if (!calib.a) el.append(h('p', {}, '1. Haz clic en el primer punto de una distancia conocida del calco (p. ej. el ancho de la calzada o una cota del croquis).'));
        else if (!calib.b) el.append(h('p', {}, '2. Haz clic en el segundo punto.'));
        else {
          const measured = Math.hypot(calib.b.x - calib.a.x, calib.b.z - calib.a.z);
          const input = h('input', { type: 'number', step: 0.01, min: 0.01, value: measured.toFixed(2) });
          el.append(
            h('p', {}, `Distancia actual en el calco: ${fmt(measured)} m. ¿Cuánto mide en realidad?`),
            h('label', { class: 'field' }, h('span', {}, 'Distancia real'), input, h('output', {}, 'm')),
            h(
              'button',
              {
                class: 'btn primary',
                onclick: () => {
                  const real = Number(input.value);
                  if (!o || !(real > 0) || measured < 0.01) return;
                  const k = real / measured;
                  const a = calib!.a!;
                  ed.store.edit(() => {
                    o.width *= k;
                    o.cx = a.x + (o.cx - a.x) * k;
                    o.cz = a.z + (o.cz - a.z) * k;
                  }, { type: 'entity', id: o.id });
                  toast(`Calco escalado ×${fmt(k, 3)}`);
                  stopCalib();
                },
              },
              'Aplicar escala',
            ),
          );
        }
        el.append(h('button', { class: 'btn', onclick: stopCalib }, 'Cancelar'));
        return;
      }

      el.append(h('div', { class: 'cat-title' }, 'Imagen de referencia'));
      const file = h('input', {
        type: 'file',
        accept: 'image/*',
        style: 'display:none',
        onchange: async (e: Event) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (!f) return;
          try {
            const { url, aspect } = await readImage(f, removeWhite);
            addOverlay(ed, url, aspect, f.name.replace(/\.[^.]+$/, ''));
            toast('Calco añadido. Ajusta posición y escala, o usa «Calibrar escala».');
          } catch (err) {
            toast(String((err as Error).message), 'error');
          }
        },
      });
      el.append(
        file,
        h('button', { class: 'btn primary', onclick: () => file.click() }, 'Cargar imagen…'),
        h(
          'label',
          { class: 'check' },
          h('input', { type: 'checkbox', checked: removeWhite, onchange: (e: Event) => (removeWhite = (e.target as HTMLInputElement).checked) }),
          'Fondo blanco transparente (croquis en papel)',
        ),
        h('p', { class: 'muted' }, 'Croquis escaneado o fotografiado, captura de Google Maps / Street View, plano… Se proyecta sobre el terreno para calcar encima.'),
      );
      if (sel?.kind === 'overlay') {
        el.append(
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                calib = { id: sel.id, a: null, b: null };
                markers.clear();
                ed.refreshOptions?.();
              },
            },
            'Calibrar escala del calco seleccionado',
          ),
        );
      }

      el.append(h('div', { class: 'cat-title' }, 'Ortofoto PNOA (IGN, España)'));
      const numIn = (label: string, key: 'lat' | 'lon' | 'size', step: number, unit = '') =>
        h(
          'label',
          { class: 'field' },
          h('span', {}, label),
          h('input', { type: 'number', step, value: pnoa[key], onchange: (e: Event) => (pnoa[key] = Number((e.target as HTMLInputElement).value)) }),
          h('output', {}, unit),
        );
      const coords = h('input', {
        type: 'text',
        placeholder: 'Pega coordenadas: 40.4168, -3.7038',
        onchange: (e: Event) => {
          const m = (e.target as HTMLInputElement).value.match(/(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)/);
          if (m) {
            pnoa.lat = Number(m[1].replace(',', '.'));
            pnoa.lon = Number(m[2].replace(',', '.'));
            ed.refreshOptions?.();
          }
        },
      });
      el.append(
        h('label', { class: 'field wide' }, coords),
        numIn('Latitud', 'lat', 0.0001),
        numIn('Longitud', 'lon', 0.0001),
        numIn('Lado', 'size', 10, 'm'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              try {
                toast('Descargando ortofoto del IGN…');
                const r = await loadPnoa(pnoa.lat, pnoa.lon, pnoa.size);
                const g = ed.store.project.geo;
                let cx = 0;
                let cz = 0;
                if (g && g.epsg === r.geo.epsg) {
                  // Escena ya georreferenciada (p. ej. con relieve real): se coloca en su sitio
                  cx = r.geo.e0 - g.e0;
                  cz = g.n0 - r.geo.n0;
                } else ed.store.edit(() => (ed.store.project.geo = r.geo), { type: 'env' });
                addOverlay(ed, r.url, 1, `Ortofoto PNOA ${pnoa.lat.toFixed(4)}, ${pnoa.lon.toFixed(4)}`, pnoa.size, cx, cz);
                toast('Ortofoto cargada y georreferenciada a escala real.');
              } catch (err) {
                toast((err as Error).message, 'error', 9000);
              }
            },
          },
          'Cargar ortofoto',
        ),
        h('p', { class: 'muted' }, 'En Google Maps: clic derecho sobre el punto → copiar coordenadas. La ortofoto (≈25 cm/píxel) queda centrada en el origen y a escala real.'),
      );
    },
  };
  return tool;
}
