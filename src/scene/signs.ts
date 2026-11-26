import * as THREE from 'three';

/** Dibujo de señales verticales (simplificadas) en canvas. */

const RED = '#c8102e';
const BLUE = '#0b4ea2';

type Draw = (g: CanvasRenderingContext2D, s: number, valor: string) => void;

function circleRing(g: CanvasRenderingContext2D, s: number, fill = '#fff') {
  g.fillStyle = RED;
  g.beginPath();
  g.arc(s / 2, s / 2, s * 0.49, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = fill;
  g.beginPath();
  g.arc(s / 2, s / 2, s * 0.38, 0, Math.PI * 2);
  g.fill();
}

function triangle(g: CanvasRenderingContext2D, s: number, down = false) {
  const tri = (inset: number) => {
    const m = s * 0.03 + inset;
    const top = down ? s - m * 1.1 - s * 0.08 : m * 1.6 + s * 0.06;
    const bot = down ? m * 1.6 + s * 0.06 : s - m * 1.1 - s * 0.08;
    g.beginPath();
    g.moveTo(s / 2, top);
    g.lineTo(s - m * 1.75, bot);
    g.lineTo(m * 1.75, bot);
    g.closePath();
  };
  g.fillStyle = RED;
  g.lineJoin = 'round';
  g.lineWidth = s * 0.04;
  g.strokeStyle = RED;
  tri(0);
  g.fill();
  g.stroke();
  g.fillStyle = '#fff';
  tri(s * 0.11);
  g.fill();
}

function pedestrian(g: CanvasRenderingContext2D, cx: number, cy: number, h: number, color = '#111') {
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineCap = 'round';
  g.lineWidth = h * 0.1;
  g.beginPath();
  g.arc(cx, cy - h * 0.42, h * 0.09, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(cx, cy - h * 0.3);
  g.lineTo(cx - h * 0.03, cy + h * 0.05);
  g.lineTo(cx - h * 0.18, cy + h * 0.45);
  g.moveTo(cx - h * 0.03, cy + h * 0.05);
  g.lineTo(cx + h * 0.15, cy + h * 0.45);
  g.moveTo(cx, cy - h * 0.22);
  g.lineTo(cx - h * 0.2, cy - h * 0.02);
  g.moveTo(cx, cy - h * 0.22);
  g.lineTo(cx + h * 0.2, cy - h * 0.05);
  g.stroke();
}

function car(g: CanvasRenderingContext2D, x: number, y: number, w: number, color: string) {
  g.fillStyle = color;
  g.beginPath();
  g.roundRect(x, y + w * 0.35, w, w * 0.45, w * 0.08);
  g.fill();
  g.beginPath();
  g.roundRect(x + w * 0.18, y, w * 0.64, w * 0.5, w * 0.12);
  g.fill();
  g.fillStyle = '#fff';
  g.fillRect(x + w * 0.26, y + w * 0.08, w * 0.48, w * 0.22);
}

export const SIGNS: Record<string, { label: string; draw: Draw }> = {
  stop: {
    label: 'R-2 STOP',
    draw: (g, s) => {
      const oct = (r: number) => {
        g.beginPath();
        for (let i = 0; i < 8; i++) {
          const a = Math.PI / 8 + (i * Math.PI) / 4;
          g.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r);
        }
        g.closePath();
      };
      g.fillStyle = '#fff';
      oct(s * 0.5);
      g.fill();
      g.fillStyle = RED;
      oct(s * 0.46);
      g.fill();
      g.fillStyle = '#fff';
      g.font = `bold ${s * 0.27}px Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('STOP', s / 2, s / 2 + s * 0.01);
    },
  },
  ceda: { label: 'R-1 Ceda el paso', draw: (g, s) => triangle(g, s, true) },
  velocidad: {
    label: 'R-301 Velocidad máxima',
    draw: (g, s, v) => {
      circleRing(g, s);
      g.fillStyle = '#111';
      g.font = `bold ${s * (v.length > 2 ? 0.3 : 0.38)}px Arial, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(v || '50', s / 2, s / 2 + s * 0.02);
    },
  },
  adelantar: {
    label: 'R-305 Adelantamiento prohibido',
    draw: (g, s) => {
      circleRing(g, s);
      car(g, s * 0.25, s * 0.36, s * 0.23, RED);
      car(g, s * 0.52, s * 0.36, s * 0.23, '#111');
    },
  },
  entrada: {
    label: 'R-101 Entrada prohibida',
    draw: (g, s) => {
      g.fillStyle = RED;
      g.beginPath();
      g.arc(s / 2, s / 2, s * 0.49, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.fillRect(s * 0.18, s * 0.42, s * 0.64, s * 0.16);
    },
  },
  estacionamiento: {
    label: 'R-308 Estacionamiento prohibido',
    draw: (g, s) => {
      circleRing(g, s, BLUE);
      g.strokeStyle = RED;
      g.lineWidth = s * 0.08;
      g.beginPath();
      g.moveTo(s * 0.25, s * 0.25);
      g.lineTo(s * 0.75, s * 0.75);
      g.stroke();
    },
  },
  curva_der: {
    label: 'P-13a Curva peligrosa a la derecha',
    draw: (g, s) => {
      triangle(g, s);
      g.strokeStyle = '#111';
      g.lineWidth = s * 0.06;
      g.beginPath();
      g.moveTo(s * 0.44, s * 0.78);
      g.lineTo(s * 0.44, s * 0.58);
      g.quadraticCurveTo(s * 0.44, s * 0.44, s * 0.58, s * 0.44);
      g.stroke();
      g.fillStyle = '#111';
      g.beginPath();
      g.moveTo(s * 0.66, s * 0.44);
      g.lineTo(s * 0.56, s * 0.37);
      g.lineTo(s * 0.56, s * 0.51);
      g.fill();
    },
  },
  curva_izq: {
    label: 'P-13b Curva peligrosa a la izquierda',
    draw: (g, s) => {
      triangle(g, s);
      g.strokeStyle = '#111';
      g.lineWidth = s * 0.06;
      g.beginPath();
      g.moveTo(s * 0.56, s * 0.78);
      g.lineTo(s * 0.56, s * 0.58);
      g.quadraticCurveTo(s * 0.56, s * 0.44, s * 0.42, s * 0.44);
      g.stroke();
      g.fillStyle = '#111';
      g.beginPath();
      g.moveTo(s * 0.34, s * 0.44);
      g.lineTo(s * 0.44, s * 0.37);
      g.lineTo(s * 0.44, s * 0.51);
      g.fill();
    },
  },
  interseccion: {
    label: 'P-1 Intersección con prioridad',
    draw: (g, s) => {
      triangle(g, s);
      g.fillStyle = '#111';
      g.fillRect(s * 0.465, s * 0.36, s * 0.07, s * 0.42);
      g.fillRect(s * 0.36, s * 0.54, s * 0.28, s * 0.05);
    },
  },
  peatones: {
    label: 'P-20 Peatones',
    draw: (g, s) => {
      triangle(g, s);
      pedestrian(g, s / 2, s * 0.6, s * 0.34);
    },
  },
  paso_peatones: {
    label: 'S-13 Paso para peatones',
    draw: (g, s) => {
      g.fillStyle = BLUE;
      g.beginPath();
      g.roundRect(s * 0.02, s * 0.02, s * 0.96, s * 0.96, s * 0.06);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.moveTo(s / 2, s * 0.12);
      g.lineTo(s * 0.88, s * 0.84);
      g.lineTo(s * 0.12, s * 0.84);
      g.closePath();
      g.fill();
      g.fillStyle = '#111';
      for (let i = 0; i < 4; i++) g.fillRect(s * (0.27 + i * 0.13), s * 0.76, s * 0.08, s * 0.05);
      pedestrian(g, s / 2, s * 0.53, s * 0.3);
    },
  },
};

const cache = new Map<string, { face: THREE.Texture; back: THREE.Texture }>();

export function signTextures(code: string, valor: string) {
  const key = code + '|' + valor;
  let t = cache.get(key);
  if (t) return t;
  const s = 512;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  (SIGNS[code] ?? SIGNS.stop).draw(g, s, valor);
  const b = document.createElement('canvas');
  b.width = b.height = s;
  const bg = b.getContext('2d')!;
  bg.drawImage(c, 0, 0);
  bg.globalCompositeOperation = 'source-in';
  bg.fillStyle = '#8c9194';
  bg.fillRect(0, 0, s, s);
  const face = new THREE.CanvasTexture(c);
  face.colorSpace = THREE.SRGBColorSpace;
  face.anisotropy = 8;
  const back = new THREE.CanvasTexture(b);
  back.colorSpace = THREE.SRGBColorSpace;
  t = { face, back };
  cache.set(key, t);
  return t;
}

/** Textura con texto (carteles, hitos). */
export function textTexture(text: string, bg: string, fg: string, w = 512, h = 256) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = fg;
  g.lineWidth = Math.min(w, h) * 0.04;
  g.strokeRect(g.lineWidth, g.lineWidth, w - 2 * g.lineWidth, h - 2 * g.lineWidth);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const lines = text.split('\n');
  const fs = Math.min(h / (lines.length + 0.6), (w / Math.max(...lines.map((l) => l.length), 1)) * 1.6);
  g.font = `bold ${fs}px Arial, sans-serif`;
  lines.forEach((l, i) => g.fillText(l, w / 2, h / 2 + (i - (lines.length - 1) / 2) * fs * 1.05));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
