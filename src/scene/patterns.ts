import * as THREE from 'three';
import { rng } from './utils';

/** Texturas de patrones (muros, vallas) generadas en canvas. 1 unidad de UV = 1 m. */
function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function speckle(g: CanvasRenderingContext2D, s: number, n: number, seed: number, alpha = 0.08) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const v = r() > 0.5 ? 255 : 0;
    g.fillStyle = `rgba(${v},${v},${v},${alpha * r()})`;
    g.fillRect(r() * s, r() * s, 1 + r() * 2, 1 + r() * 2);
  }
}

export const PATTERN = {
  hormigon: canvasTex(256, (g, s) => {
    g.fillStyle = '#a9a59d';
    g.fillRect(0, 0, s, s);
    speckle(g, s, 4000, 1, 0.15);
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 2;
    g.strokeRect(0, 0, s, s);
  }),
  piedra: canvasTex(256, (g, s) => {
    g.fillStyle = '#6f675c';
    g.fillRect(0, 0, s, s);
    const r = rng(3);
    for (let y = 0; y < s; y += 40) {
      let x = -r() * 40;
      while (x < s) {
        const w = 40 + r() * 50;
        const c = 110 + r() * 60;
        g.fillStyle = `rgb(${c},${c * 0.94},${c * 0.86})`;
        g.beginPath();
        g.roundRect(x + 3, y + 3, w - 6, 34, 8);
        g.fill();
        x += w;
      }
    }
    speckle(g, s, 3000, 4, 0.2);
  }),
  ladrillo: canvasTex(256, (g, s) => {
    g.fillStyle = '#c9c0b2';
    g.fillRect(0, 0, s, s);
    const r = rng(5);
    const bh = s / 16;
    const bw = s / 4;
    for (let row = 0; row < 16; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let x = -bw; x < s + bw; x += bw) {
        const c = 150 + r() * 40;
        g.fillStyle = `rgb(${c},${c * 0.52},${c * 0.38})`;
        g.fillRect(x + off + 1.5, row * bh + 1.5, bw - 3, bh - 3);
      }
    }
    speckle(g, s, 2000, 6, 0.15);
  }),
  bloque: canvasTex(256, (g, s) => {
    g.fillStyle = '#8d8a84';
    g.fillRect(0, 0, s, s);
    const bh = s / 5;
    const bw = s / 2.5;
    for (let row = 0; row < 5; row++) {
      const off = row % 2 ? bw / 2 : 0;
      for (let x = -bw; x < s + bw; x += bw) {
        g.fillStyle = '#b3afa7';
        g.fillRect(x + off + 2, row * bh + 2, bw - 4, bh - 4);
      }
    }
    speckle(g, s, 3000, 7, 0.2);
  }),
  malla: canvasTex(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.strokeStyle = '#9aa1a3';
    g.lineWidth = 2.2;
    const step = s / 8;
    for (let i = -8; i <= 16; i++) {
      g.beginPath();
      g.moveTo(i * step, 0);
      g.lineTo(i * step + s, s);
      g.stroke();
      g.beginPath();
      g.moveTo(i * step, s);
      g.lineTo(i * step + s, 0);
      g.stroke();
    }
  }),
  barrotes: canvasTex(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    g.fillStyle = '#2f3436';
    for (let x = 0; x < s; x += s / 8) g.fillRect(x, 0, 4, s);
    g.fillRect(0, 4, s, 5);
    g.fillRect(0, s - 9, s, 5);
  }),
  madera: canvasTex(128, (g, s) => {
    g.clearRect(0, 0, s, s);
    const r = rng(9);
    const ph = s / 5;
    for (let i = 0; i < 5; i++) {
      const c = 120 + r() * 30;
      g.fillStyle = `rgb(${c},${c * 0.75},${c * 0.5})`;
      g.fillRect(0, i * ph + 3, s, ph - 8);
    }
  }),
  hojas: canvasTex(256, (g, s) => {
    g.fillStyle = '#3f5a2a';
    g.fillRect(0, 0, s, s);
    const r = rng(11);
    for (let i = 0; i < 2500; i++) {
      const c = r();
      g.fillStyle = c > 0.5 ? `rgba(110,140,70,${0.3 + r() * 0.4})` : `rgba(25,40,18,${0.3 + r() * 0.4})`;
      g.beginPath();
      g.ellipse(r() * s, r() * s, 2 + r() * 4, 1 + r() * 3, r() * 3, 0, Math.PI * 2);
      g.fill();
    }
  }),
};
