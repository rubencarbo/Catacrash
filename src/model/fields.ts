/** Descripción de un parámetro editable (para generar formularios en el inspector). */
export type FieldDef =
  | { key: string; label: string; type: 'number'; unit?: string; min?: number; max?: number; step?: number }
  | { key: string; label: string; type: 'select'; options: [string, string][] }
  | { key: string; label: string; type: 'bool' }
  | { key: string; label: string; type: 'text' }
  | { key: string; label: string; type: 'color' };

export const num = (
  key: string,
  label: string,
  unit = 'm',
  min = 0,
  max = 100,
  step = 0.05,
): FieldDef => ({ key, label, type: 'number', unit, min, max, step });

export const sel = (key: string, label: string, options: [string, string][]): FieldDef => ({
  key,
  label,
  type: 'select',
  options,
});

export const bool = (key: string, label: string): FieldDef => ({ key, label, type: 'bool' });
export const text = (key: string, label: string): FieldDef => ({ key, label, type: 'text' });
export const color = (key: string, label: string): FieldDef => ({ key, label, type: 'color' });
