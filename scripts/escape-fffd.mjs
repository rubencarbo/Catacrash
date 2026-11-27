// El SDK incluye un carácter U+FFFD literal; en el HTML de un solo archivo se escapa para que
// no se confunda con un carácter perdido.
import { readFileSync, writeFileSync } from 'node:fs';
const f = process.argv[2] ?? 'dist-demo/index.html';
const s = readFileSync(f, 'utf8');
writeFileSync(f, s.replace(/`\uFFFD`/g, '`\\uFFFD`').replace(/"\uFFFD"/g, '"\\uFFFD"').replace(/'\uFFFD'/g, "'\\uFFFD'"));
const left = (readFileSync(f, 'utf8').match(/\uFFFD/g) ?? []).length;
if (left) console.warn(`Quedan ${left} caracteres U+FFFD en ${f}`);
