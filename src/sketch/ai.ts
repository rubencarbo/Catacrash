import { normalizeSketch, parseJsonLoose, sketchPrompt, type SketchResult } from './schema';

/**
 * Lectura del croquis con un modelo de visión (Claude).
 * - Dentro de claude.ai (artefacto publicado) usa la capacidad `sample` de la página: responde
 *   Claude con la cuenta de quien la está viendo, sin claves.
 * - Fuera (instalación propia), con una clave de la API de Anthropic que el usuario guarda en su
 *   navegador.
 */

const KEY_STORE = 'catacrash.anthropicKey';
const MODEL = 'claude-opus-5-5';

interface SampleNs {
  json<T = unknown>(input: string, opts?: Record<string, unknown>): Promise<T>;
  limits(): Promise<{ images?: { maxCount: number; maxInputBytes: number; mediaTypes: string[] } }>;
}
interface ClaudeWindow {
  claude?: { use(name: string): Promise<unknown> };
}

let samplePromise: Promise<SampleNs | null> | null = null;
/** La capacidad `sample` con imágenes, o null si esta vista no la tiene. */
export function sampleWithImages(): Promise<SampleNs | null> {
  samplePromise ??= (async () => {
    const c = (window as unknown as ClaudeWindow).claude;
    if (!c?.use) return null;
    try {
      const s = (await c.use('sample')) as SampleNs | null;
      if (!s) return null;
      const lim = await s.limits().catch(() => null);
      return lim?.images ? s : null;
    } catch {
      return null;
    }
  })();
  return samplePromise;
}

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? '';
  } catch {
    return '';
  }
}
export function setApiKey(k: string) {
  try {
    if (k) localStorage.setItem(KEY_STORE, k);
    else localStorage.removeItem(KEY_STORE);
  } catch {
    /* sin almacenamiento */
  }
}

export type VisionMode = 'claude' | 'apikey' | 'none';
export async function visionMode(): Promise<VisionMode> {
  if (await sampleWithImages()) return 'claude';
  return getApiKey() ? 'apikey' : 'none';
}

/** Prepara la imagen para enviarla: orientación correcta, lado mayor ≤ 1400 px, JPEG. */
export async function prepareImage(blob: Blob, maxSide = 1400): Promise<{ blob: Blob; width: number; height: number; dataUrl: string }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('No se pudo leer la imagen'));
      i.src = url;
    });
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    const out = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('No se pudo preparar la imagen'))), 'image/jpeg', 0.9));
    return { blob: out, width: c.width, height: c.height, dataUrl: c.toDataURL('image/jpeg', 0.9) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export class VisionError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const SAMPLE_MSG: Record<string, string> = {
  not_granted: 'No se ha dado permiso para consultar a Claude desde esta página.',
  rate_limited: 'Se ha alcanzado el límite de uso de Claude por ahora. Prueba más tarde.',
  images_unavailable: 'Esta vista no puede enviar imágenes a Claude.',
  image_rejected: 'Claude no ha aceptado la imagen (formato o tamaño).',
  refused: 'Claude no ha querido procesar esta imagen.',
  invalid_json: 'La respuesta no se pudo leer. Vuelve a intentarlo.',
  cancelled: 'Cancelado.',
  session_expired: 'La sesión ha caducado: recarga la página.',
};

/**
 * Pide la interpretación del croquis. `onProgress` recibe el texto que se va generando
 * (para mostrar que avanza).
 */
export async function readSketch(image: Blob, onProgress?: (chars: number) => void, signal?: AbortSignal): Promise<{ result: SketchResult; width: number; height: number; dataUrl: string }> {
  const prep = await prepareImage(image);
  const prompt = sketchPrompt(prep.width, prep.height);
  const sample = await sampleWithImages();
  let raw: unknown;
  if (sample) {
    try {
      raw = await sample.json(prompt, {
        images: [prep.blob],
        modelTier: 'complex',
        cache: false,
        signal,
        onText: ({ text }: { text: string }) => onProgress?.(text.length),
      });
    } catch (e) {
      const code = (e as { code?: string }).code ?? 'error';
      throw new VisionError(SAMPLE_MSG[code] ?? `No se pudo leer el croquis (${code}).`, code);
    }
  } else {
    const key = getApiKey();
    if (!key) throw new VisionError('Para leer el croquis hace falta Claude: abre la app en claude.ai o guarda una clave de la API de Anthropic.', 'no_key');
    raw = await readWithApiKey(key, prompt, prep.dataUrl, onProgress, signal);
  }
  return { result: normalizeSketch(raw), width: prep.width, height: prep.height, dataUrl: prep.dataUrl };
}

async function readWithApiKey(key: string, prompt: string, dataUrl: string, onProgress?: (n: number) => void, signal?: AbortSignal): Promise<unknown> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  try {
    const stream = client.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 32000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      },
      { signal },
    );
    let n = 0;
    stream.on('text', (d) => onProgress?.((n += d.length)));
    const msg = await stream.finalMessage();
    if (msg.stop_reason === 'refusal') throw new VisionError('Claude no ha querido procesar esta imagen.', 'refused');
    const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    try {
      return parseJsonLoose(text);
    } catch {
      throw new VisionError('La respuesta no se pudo leer. Vuelve a intentarlo.', 'invalid_json');
    }
  } catch (e) {
    if (e instanceof VisionError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new VisionError('La clave de la API no es válida.', 'auth');
    if (e instanceof Anthropic.RateLimitError) throw new VisionError('Límite de uso de la API alcanzado. Prueba más tarde.', 'rate_limited');
    if (e instanceof Anthropic.APIUserAbortError) throw new VisionError('Cancelado.', 'cancelled');
    if (e instanceof Anthropic.APIError) throw new VisionError(`Error de la API (${e.status ?? 'red'}): ${e.message}`, 'api');
    throw new VisionError(`No se pudo contactar con la API: ${(e as Error).message}`, 'network');
  }
}
