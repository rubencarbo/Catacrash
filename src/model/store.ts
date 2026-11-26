import type { Entity, ID, Project, Selection } from './types';

export type Change =
  | { type: 'entity'; id: ID }
  | { type: 'entities' }
  | { type: 'terrain' }
  | { type: 'env' }
  | { type: 'all' };

type Listener = (c: Change) => void;
type SelListener = (s: Selection | null) => void;

const MAX_UNDO = 60;

let idCounter = 0;
export function newId(prefix = 'e'): ID {
  idCounter++;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/**
 * Estado central de la aplicación: proyecto, selección, deshacer/rehacer y autoguardado.
 * Las imágenes (assets) viven fuera del proyecto para que el historial no las duplique.
 */
export class Store {
  project: Project;
  assets = new Map<ID, string>();
  selection: Selection | null = null;

  private undoStack: Project[] = [];
  private redoStack: Project[] = [];
  private pending: Project | null = null;
  private listeners: Listener[] = [];
  private selListeners: SelListener[] = [];
  private saveTimer: number | undefined;
  onSaved: ((ok: boolean) => void) | null = null;

  constructor(project: Project) {
    this.project = project;
  }

  // ---------- eventos ----------
  on(fn: Listener) {
    this.listeners.push(fn);
  }
  onSelect(fn: SelListener) {
    this.selListeners.push(fn);
  }
  notify(c: Change) {
    for (const l of this.listeners) l(c);
    this.scheduleSave();
  }

  // ---------- historial ----------
  /** Abre una transacción: guarda el estado previo (solo la primera vez). */
  begin() {
    if (!this.pending) this.pending = structuredClone(this.project);
  }
  /** Cierra la transacción y la apila en el historial. */
  end() {
    if (!this.pending) return;
    this.undoStack.push(this.pending);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.pending = null;
  }
  /** Ejecuta un cambio atómico deshacible. */
  edit(fn: () => void, change: Change) {
    this.begin();
    fn();
    this.end();
    this.notify(change);
  }
  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }
  undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.project);
    this.project = prev;
    this.fixSelection();
    this.notify({ type: 'all' });
  }
  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.project);
    this.project = next;
    this.fixSelection();
    this.notify({ type: 'all' });
  }
  /** Sustituye el proyecto entero (abrir archivo, nuevo…). */
  load(p: Project, assets?: Map<ID, string>) {
    this.project = p;
    if (assets) this.assets = assets;
    this.undoStack = [];
    this.redoStack = [];
    this.pending = null;
    this.select(null);
    this.notify({ type: 'all' });
  }

  // ---------- entidades ----------
  get(id: ID): Entity | undefined {
    return this.project.entities.find((e) => e.id === id);
  }
  add(e: Entity) {
    this.edit(() => this.project.entities.push(e), { type: 'entities' });
  }
  remove(id: ID) {
    this.edit(() => {
      this.project.entities = this.project.entities.filter((e) => e.id !== id);
    }, { type: 'entities' });
    if (this.selection?.id === id) this.select(null);
  }

  // ---------- selección ----------
  select(s: Selection | null) {
    this.selection = s;
    for (const l of this.selListeners) l(s);
  }
  private fixSelection() {
    if (this.selection && !this.get(this.selection.id)) this.select(null);
    else this.select(this.selection);
  }

  // ---------- persistencia local (IndexedDB) ----------
  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      idbSet('project', { project: this.project, assets: Object.fromEntries(this.assets) })
        .then(() => this.onSaved?.(true))
        .catch(() => this.onSaved?.(false));
    }, 800);
  }
}

// ---------- IndexedDB mínimo ----------
function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('catacrash', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbSet(key: string, value: unknown) {
  const db = await openDb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
  db.close();
}
export async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    const v = await new Promise<T | undefined>((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const r = tx.objectStore('kv').get(key);
      r.onsuccess = () => res(r.result as T | undefined);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return v;
  } catch {
    return undefined;
  }
}
