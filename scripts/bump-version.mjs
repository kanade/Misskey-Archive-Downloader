import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const versionFile = join(__dirname, '../src/version.ts');

// JST の今日の日付を YYYY.MM.DD 形式で取得
const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
const yyyy = now.getUTCFullYear();
const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
const dd = String(now.getUTCDate()).padStart(2, '0');
const today = `${yyyy}.${mm}.${dd}`;

// 現在のバージョンを読み込む
let current = '';
try {
  const src = readFileSync(versionFile, 'utf-8');
  const m = src.match(/VERSION = '([^']+)'/);
  if (m) current = m[1];
} catch { /* 初回 */ }

// 日付部分が今日と同じならカウントアップ、違えば 1 にリセット
let n = 1;
if (current.startsWith(today + '.')) {
  n = parseInt(current.slice(today.length + 1), 10) + 1;
}

const version = `${today}.${String(n).padStart(3, '0')}`;
writeFileSync(versionFile, `export const VERSION = '${version}';\n`);
console.log(`Version bumped: ${version}`);
