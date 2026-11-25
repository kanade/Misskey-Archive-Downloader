// Writes the viewer (index.html) from src/lib/viewer-template.ts with the version in src/version.ts.
// Requires Node.js with TypeScript type stripping (22.18 or later).
// Usage: node scripts/build-viewer.mjs [output folder]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { viewerHtml } from '../src/lib/viewer-template.ts';
import { VERSION } from '../src/version.ts';

const outDir = process.argv[2] ?? 'dist-viewer';
mkdirSync(outDir, { recursive: true });
const path = join(outDir, 'index.html');
writeFileSync(path, viewerHtml(VERSION));
console.log(`${path} (${VERSION})`);
