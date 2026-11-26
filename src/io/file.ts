import type { Project } from '../model/types';

function f32ToB64(a: Float32Array) {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function b64ToF32(b: string) {
  const s = atob(b);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** Serializa proyecto + imágenes en un único JSON portable (.catacrash.json). */
export function serialize(p: Project, assets: Map<string, string>): string {
  const used = new Set<string>();
  for (const e of p.entities) {
    if (e.kind === 'overlay' || e.kind === 'photo') used.add(e.asset);
    if (e.kind === 'vehicle') e.photos.forEach((a) => used.add(a));
  }
  return JSON.stringify({
    format: 'catacrash',
    project: { ...p, terrain: { ...p.terrain, base: f32ToB64(p.terrain.base) } },
    assets: Object.fromEntries([...assets].filter(([k]) => used.has(k))),
  });
}

export function deserialize(text: string): { project: Project; assets: Map<string, string> } {
  const o = JSON.parse(text);
  if (o.format !== 'catacrash') throw new Error('El archivo no es un escenario de Catacrash');
  const p = o.project as Project & { terrain: { base: string } };
  const project: Project = { ...p, terrain: { ...p.terrain, base: b64ToF32(p.terrain.base) } } as Project;
  return { project, assets: new Map(Object.entries(o.assets ?? {})) };
}

export function download(name: string, content: string | Blob, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => res(i.files?.[0] ?? null);
    i.click();
  });
}
