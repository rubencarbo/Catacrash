import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build:demo` genera un único HTML autocontenido (útil para enseñar demos).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'demo' ? [viteSingleFile()] : [],
  build: {
    outDir: mode === 'demo' ? 'dist-demo' : 'dist',
    chunkSizeWarningLimit: 2000,
  },
}));
