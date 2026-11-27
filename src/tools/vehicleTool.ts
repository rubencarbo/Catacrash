import * as THREE from 'three';
import type { Editor, Tool } from '../editor';
import { newId } from '../model/store';
import type { SpecKey, VehicleEntity, VehicleSpec, VehicleType } from '../model/types';
import { buildVehicle } from '../scene/vehicle3d';
import { fmt, h, toast } from '../ui/dom';
import { ICON } from '../ui/icons';
import { headingText, roadHeadings } from './dial';
import { loadCatalog, loadLibrary, removeFromLibrary, searchCatalog, type SavedVehicle } from '../vehicles/catalog';
import { completeSpec, genericSpec, parsePastedSpec, specFromRecord, TYPICAL, type CatalogRecord } from '../vehicles/spec';
import { pickEntity } from './basic';

const COLORS = ['#c62828', '#1565c0', '#f2f2f2', '#2e7d32', '#212121', '#9e9e9e', '#f9a825', '#6d4c41'];

export function specTitle(s: VehicleSpec) {
  const name = [s.marca, s.modelo].filter(Boolean).join(' ');
  return name ? `${name}${s.version && !s.version.toLowerCase().startsWith(s.modelo.toLowerCase()) ? ' · ' + s.version : ''}` : TYPICAL[s.tipo].label;
}

export function nextLabel(ed: Editor) {
  const used = new Set(ed.store.project.entities.filter((e): e is VehicleEntity => e.kind === 'vehicle').map((e) => e.label));
  for (let i = 0; i < 26; i++) {
    const l = String.fromCharCode(65 + i);
    if (!used.has(l)) return l;
  }
  return `V${used.size + 1}`;
}

/** Herramienta de vehículos: genéricos, catálogo de modelos reales, biblioteca propia y ficha pegada. */
export function vehicleTool(ed: Editor): Tool {
  let tab: 'genericos' | 'catalogo' | 'biblioteca' | 'ficha' = 'genericos';
  let pending: VehicleSpec | null = null;
  let heading = 0;
  let ghost: THREE.Object3D | null = null;
  let query = '';
  let results: CatalogRecord[] = [];
  let catalogCount = 0;
  let catalogError = '';
  let library: SavedVehicle[] = [];
  let pasted = '';
  let pastedType: VehicleType = 'compacto';
  let applyTo: string | null = null;

  const clearGhost = () => {
    if (ghost) ed.vp.scene.remove(ghost);
    ghost = null;
  };
  const makeGhost = () => {
    clearGhost();
    if (!pending) return;
    const tmp = { id: 'ghost', kind: 'vehicle', name: '', label: '', spec: pending, x: 0, z: 0, heading: 0, color: '#9aa4ad', plate: '', occupants: 1, cargo: 0, damage: [], photos: [] } as VehicleEntity;
    const g = new THREE.Group();
    g.rotation.order = 'YXZ';
    g.add(buildVehicle(tmp));
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const ghostOf = (mm: THREE.Material) => {
        const c = mm.clone();
        c.transparent = true;
        c.opacity = 0.5;
        c.depthWrite = false;
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(ghostOf) : ghostOf(m.material);
      m.castShadow = false;
    });
    g.visible = false;
    ghost = g;
    ed.vp.scene.add(g);
  };

  /** Usa una ficha: o bien para colocar un vehículo nuevo, o para sustituir la del seleccionado. */
  const use = (spec: VehicleSpec) => {
    if (applyTo) {
      const e = ed.store.get(applyTo);
      if (e && e.kind === 'vehicle') {
        ed.store.edit(() => (e.spec = structuredClone(spec)), { type: 'entity', id: e.id });
        toast(`${e.label}: ficha cambiada a ${specTitle(spec)}.`);
      }
      applyTo = null;
      ed.setTool('select');
      ed.select(e?.id ?? null);
      return;
    }
    pending = spec;
    makeGhost();
    ed.refreshOptions?.();
  };

  /** Alinea el rumbo con la carretera más cercana (en el sentido más parecido al actual). */
  const roadHeading = (x: number, z: number): number | null => {
    let best: { d: number; tx: number; tz: number } | null = null;
    for (const e of ed.store.project.entities) {
      if (e.kind !== 'road') continue;
      const S = ed.world.samples.get(e.id);
      if (!S) continue;
      for (const s of S) {
        const d = Math.hypot(s.x - x, s.z - z);
        if (d < 8 && (!best || d < best.d)) best = { d, tx: s.tx, tz: s.tz };
      }
    }
    if (!best) return null;
    const hdg = ((Math.atan2(best.tx, -best.tz) * 180) / Math.PI + 360) % 360;
    const diff = Math.abs(((hdg - heading + 540) % 360) - 180);
    return diff > 90 ? (hdg + 180) % 360 : hdg;
  };

  /** Coloca el vehículo elegido en (x, z) con el rumbo actual. */
  let aim: { x: number; z: number; dragged: boolean } | null = null;
  let placedAt = 0;
  const place = (x: number, z: number) => {
    if (!pending) return;
    const n = ed.store.project.entities.filter((e) => e.kind === 'vehicle').length;
      const label = nextLabel(ed);
      const e: VehicleEntity = {
        id: newId('v'),
        kind: 'vehicle',
        name: `${label} · ${specTitle(pending)}`,
        label,
        spec: structuredClone(pending),
        x,
        z,
        heading,
        color: pending.tipo === 'peaton' ? '#3d6e9e' : COLORS[n % COLORS.length],
        plate: '',
        occupants: pending.tipo === 'peaton' ? 0 : 1,
        cargo: 0,
        damage: [],
        photos: [],
      };
      ed.store.add(e);
      pending = null;
      clearGhost();
      ed.select(e.id);
      ed.refreshOptions?.();
  };

  const doSearch = async () => {
    try {
      const list = await loadCatalog();
      catalogCount = list.length;
      catalogError = '';
      results = searchCatalog(list, query);
    } catch (err) {
      catalogError = (err as Error).message;
    }
    ed.refreshOptions?.();
  };

  const tool: Tool = {
    id: 'vehicle',
    label: 'Vehículos y peatones',
    icon: ICON.car,
    key: 'h',
    hint: 'Elige un vehículo y haz clic donde va (se alinea solo con el carril) o pulsa y arrastra en el sentido de la marcha · Q/E: girar · Mayús: sin alinear',
    busy() {
      return !!pending || !!applyTo;
    },
    activate() {
      loadLibrary().then((l) => {
        library = l;
        if (tab === 'biblioteca') ed.refreshOptions?.();
      });
    },
    deactivate() {
      clearGhost();
      pending = null;
      applyTo = null;
    },
    down(ev) {
      // con un vehículo elegido: pulsar fija el sitio y arrastrar marca el sentido de la marcha
      if (!pending || !ev.ground) return false;
      aim = { x: ev.ground.x, z: ev.ground.z, dragged: false };
      return true;
    },
    up(ev) {
      if (!aim) return;
      const a = aim;
      aim = null;
      ed.setHint?.(tool.hint ?? '');
      if (a.dragged) place(a.x, a.z);
      else if (ev.ground) place(ev.ground.x, ev.ground.z);
      placedAt = performance.now();
    },
    move(ev) {
      if (!ghost || !pending) return;
      if (aim) {
        if (!ev.ground) return;
        const dx = ev.ground.x - aim.x;
        const dz = ev.ground.z - aim.z;
        if (Math.hypot(dx, dz) > 0.8) {
          aim.dragged = true;
          heading = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
          if (!(ev.e as PointerEvent).shiftKey)
            for (const rh of roadHeadings(ed.world, aim.x, aim.z)) if (Math.abs(((heading - rh + 540) % 360) - 180) < 7) heading = rh;
          ghost.rotation.set(0, (-heading * Math.PI) / 180, 0, 'YXZ');
          ed.setHint?.(`Sentido de la marcha: ${headingText(heading)} · suelta para colocarlo`);
        }
        return;
      }
      if (!ev.ground) {
        ghost.visible = false;
        return;
      }
      if (!(ev.e as PointerEvent).shiftKey) {
        const rh = roadHeading(ev.ground.x, ev.ground.z);
        if (rh !== null) heading = rh;
      }
      ghost.visible = true;
      ghost.position.set(ev.ground.x, ed.world.surfaceHeight(ev.ground.x, ev.ground.z), ev.ground.z);
      ghost.rotation.set(0, (-heading * Math.PI) / 180, 0, 'YXZ');
    },
    click(ev) {
      // el clic que acompaña a la colocación no debe seleccionar lo que haya debajo
      if (performance.now() - placedAt < 400) return;
      if (!pending) ed.select(pickEntity(ed, ev));
    },
    onKey(e) {
      const k = e.key.toLowerCase();
      if (pending && (k === 'q' || k === 'e')) {
        heading = (heading + (k === 'e' ? 15 : -15) + 360) % 360;
        if (ghost) ghost.rotation.y = (-heading * Math.PI) / 180;
        return true;
      }
      if (e.key === 'Escape' && (pending || applyTo)) {
        pending = null;
        applyTo = null;
        clearGhost();
        ed.refreshOptions?.();
        return true;
      }
      return false;
    },
    options(el) {
      if (applyTo) {
        const v = ed.store.get(applyTo);
        el.append(h('p', { class: 'muted' }, `Elige la nueva ficha para ${v?.name ?? 'el vehículo'} (Esc para cancelar).`));
      }
      if (pending) {
        el.append(
          h(
            'div',
            { class: 'pending-box' },
            h('strong', {}, specTitle(pending)),
            h('div', { class: 'muted' }, `${fmt(pending.L)} × ${fmt(pending.W)} × ${fmt(pending.H)} m · ${pending.masa.toLocaleString('es-ES')} kg`),
            h('div', {}, 'Haz clic en la escena para colocarlo. Sobre una carretera se alinea solo con el carril.'),
            h('button', { class: 'btn small', onclick: () => ((pending = null), clearGhost(), ed.refreshOptions?.()) }, 'Cancelar'),
          ),
        );
      }
      const tabs = h('div', { class: 'seg' });
      for (const [k, l] of [
        ['genericos', 'Genéricos'],
        ['catalogo', 'Catálogo'],
        ['biblioteca', 'Mi biblioteca'],
        ['ficha', 'Pegar ficha'],
      ] as [typeof tab, string][])
        tabs.append(
          h(
            'button',
            {
              class: k === tab ? 'active' : '',
              onclick: async () => {
                tab = k;
                if (k === 'biblioteca') library = await loadLibrary();
                ed.refreshOptions?.();
              },
            },
            l,
          ),
        );
      el.append(tabs);

      if (tab === 'genericos') {
        let group = '';
        let grid: HTMLElement | null = null;
        for (const [k, t] of Object.entries(TYPICAL) as [VehicleType, (typeof TYPICAL)[VehicleType]][]) {
          if (t.grupo !== group) {
            group = t.grupo;
            el.append(h('div', { class: 'cat-title' }, group));
            grid = h('div', { class: 'catalog' });
            el.append(grid);
          }
          grid!.append(h('button', { class: 'cat-item', onclick: () => use(genericSpec(k)), title: `${fmt(t.L)} × ${fmt(t.W)} × ${fmt(t.H)} m · ${t.masa} kg` }, t.label));
        }
        el.append(h('p', { class: 'muted' }, 'Medidas típicas del tipo. Después puedes ajustar cualquier dato en el inspector.'));
      } else if (tab === 'catalogo') {
        const input = h('input', {
          type: 'search',
          placeholder: 'Marca, modelo, año… (p. ej. «seat leon 2016»)',
          value: query,
          oninput: (e: Event) => {
            query = (e.target as HTMLInputElement).value;
            clearTimeout((input as unknown as { _t: number })._t);
            (input as unknown as { _t: number })._t = window.setTimeout(async () => {
              await doSearch();
              const again = el.querySelector('input[type=search]') as HTMLInputElement | null;
              again?.focus();
              again?.setSelectionRange(query.length, query.length);
            }, 220);
          },
        });
        el.append(input);
        if (catalogError) el.append(h('p', { class: 'muted' }, catalogError));
        else if (catalogCount) el.append(h('p', { class: 'muted' }, query ? `${results.length === 60 ? 'Más de 60' : results.length} resultados de ${catalogCount.toLocaleString('es-ES')} generaciones.` : `${catalogCount.toLocaleString('es-ES')} generaciones de turismos y furgonetas.`));
        else loadCatalog().then((l) => ((catalogCount = l.length), ed.refreshOptions?.())).catch((e) => ((catalogError = (e as Error).message), ed.refreshOptions?.()));
        const list = h('div', { class: 'results' });
        for (const r of results) {
          const sp = specFromRecord(r);
          const years = `${r.desde ?? '¿?'}–${r.hasta ?? ''}`;
          list.append(
            h(
              'button',
              { class: 'result', onclick: () => use(sp) },
              h('span', { class: 'r-title' }, r.generacion),
              h('span', { class: 'r-meta' }, `${years} · ${r.carroceria ?? r.tipo ?? ''}`),
              h('span', { class: 'r-meta' }, `${fmt(sp.L)} × ${fmt(sp.W)} × ${fmt(sp.H)} m · batalla ${fmt(sp.batalla)} · ${sp.masa.toLocaleString('es-ES')} kg${sp.origen.masa === 'estimado' ? ' (est.)' : ''}`),
            ),
          );
        }
        el.append(list, h('p', { class: 'muted' }, 'Datos de auto-data.net por generación (una versión representativa). Revisa el peso de la versión concreta en su ficha técnica.'));
      } else if (tab === 'biblioteca') {
        if (!library.length) el.append(h('p', { class: 'muted' }, 'Aún no has guardado vehículos. Selecciona uno en la escena y pulsa «Guardar en mi biblioteca».'));
        for (const v of library)
          el.append(
            h(
              'div',
              { class: 'band-row', style: 'grid-template-columns:1fr auto' },
              h('button', { class: 'result', onclick: () => use(structuredClone(v.spec)) }, h('span', { class: 'r-title' }, v.name), h('span', { class: 'r-meta' }, `${fmt(v.spec.L)} × ${fmt(v.spec.W)} × ${fmt(v.spec.H)} m · ${v.spec.masa} kg`)),
              h('button', {
                class: 'icon-btn small danger',
                title: 'Quitar de la biblioteca',
                html: ICON.trash,
                onclick: async () => {
                  await removeFromLibrary(v.name);
                  library = await loadLibrary();
                  ed.refreshOptions?.();
                },
              }),
            ),
          );
      } else {
        const ta = h('textarea', {
          rows: 9,
          placeholder: 'Pega aquí el texto de la ficha: auto-data, km77, ultimatespecs, la ficha técnica ITV… (Longitud, Anchura, Altura, Distancia entre ejes, Vías, Voladizos, Peso en orden de marcha, neumáticos…)',
          oninput: (e: Event) => (pasted = (e.target as HTMLTextAreaElement).value),
        });
        ta.value = pasted;
        const typeSel = h('select', { onchange: (e: Event) => (pastedType = (e.target as HTMLSelectElement).value as VehicleType) });
        for (const [k, t] of Object.entries(TYPICAL)) typeSel.append(h('option', { value: k, selected: k === pastedType }, t.label));
        const out = h('div', {});
        el.append(
          ta,
          h('label', { class: 'field' }, h('span', {}, 'Tipo'), typeSel),
          h(
            'button',
            {
              class: 'btn primary',
              onclick: () => {
                const { values, tyre, found } = parsePastedSpec(pasted);
                if (!found.length) {
                  out.replaceChildren(h('p', { class: 'muted' }, 'No he encontrado medidas reconocibles. Comprueba que el texto incluya las etiquetas (Longitud, Anchura…) seguidas de sus valores.'));
                  return;
                }
                const origen: VehicleSpec['origen'] = {};
                for (const k of found) origen[k as SpecKey] = 'ficha';
                if (tyre) origen.rueda = 'ficha';
                const spec = completeSpec({ tipo: pastedType, ...values, rueda: tyre ?? undefined, origen });
                out.replaceChildren(
                  h('p', { class: 'muted' }, `Leídos: ${found.join(', ')}${tyre ? ', rueda' : ''}. El resto se estima.`),
                  h('button', { class: 'btn', onclick: () => use(spec) }, applyTo ? 'Aplicar al vehículo' : 'Usar esta ficha'),
                );
              },
            },
            'Leer datos',
          ),
          out,
        );
      }
    },
  };
  ed.vehicleChangeSpec = (id: string) => {
    applyTo = id;
    ed.setTool('vehicle');
    ed.refreshOptions?.();
  };
  return tool;
}
