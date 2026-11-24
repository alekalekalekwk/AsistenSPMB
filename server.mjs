/*
 * Server lokal Sigi. Membaca API key Netra dan Deepgram dari .env, jadi key tidak perlu diketik di browser.
 *
 *   node server.mjs          -> buka http://127.0.0.1:8123
 *   node server.mjs --cek    -> cek apakah key di .env diterima (tanpa menjalankan AI)
 *
 * Hanya untuk laptop sendiri: server ini cuma menerima koneksi dari komputer yang sama.
 * Situs di GitHub Pages tidak punya server, jadi di sana key tetap diketik di halaman.
 */
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDeepgram, checkKey, cleanKey, configure, handleApi, handleListen, isCleanKey, keyId, log, oneLine, sendError } from './lib/sigi-api.mjs';

const ROOT = await realpath(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 8123;
const ENV_FILE = process.env.SIGI_ENV_FILE || join(ROOT, '.env');
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

// Hanya jenis file ini yang dilayani. Server sendiri (.mjs) dan file tersembunyi (.env, .git) tidak pernah.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

// Satu-satunya file di folder tersembunyi yang boleh dibuka: script audit tampilan (skill ui-design-review).
const HIDDEN_ALLOWED = new Set(['/.claude/skills/ui-design-review/scripts/ui-audit.js']);

/* .env */

// Dibaca ulang setiap permintaan, jadi mengganti key tidak perlu menyalakan ulang server.
async function readKey(name) {
  let text;
  try {
    text = await readFile(ENV_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = '';
  }
  let key = '';
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`));
    const value = match ? cleanKey(match[1], name) : '';
    if (value) key = value; // baris kosong tidak menimpa baris yang sudah diisi
  }
  return key;
}

configure({
  readKey,
  isAllowedHost: (host) => HOSTS.has(host),
  originFor: (host) => `http://${host}`,
  needsPassword: false, // hanya bisa dibuka dari komputer ini
});

/* File website */

async function handleFile(req, res, pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    path = '';
  }
  if (path.endsWith('/')) path += 'index.html';
  const hidden = path.split(/[/\\]/).some((part) => part.startsWith('.')) && !HIDDEN_ALLOWED.has(path);
  const type = TYPES[extname(path).toLowerCase()];
  let file = null;
  if (path.startsWith('/') && !path.includes('\0') && !hidden && type) {
    file = await realpath(join(ROOT, path)).catch(() => null);
    // Symlink yang menunjuk ke luar folder repo tidak dilayani.
    if (file && (!file.startsWith(ROOT + sep) || !(await stat(file)).isFile())) file = null;
  }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Tidak ditemukan');
    return;
  }
  // Dibaca sekaligus karena semua file kecil, jadi tidak ada file yang tertinggal terbuka kalau browser memutus.
  const content = await readFile(file);
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
  res.end(req.method === 'HEAD' ? undefined : content);
}

/* Server */

async function handle(req, res) {
  if (await handleApi(req, res)) return;
  if (req.method === 'GET' || req.method === 'HEAD') await handleFile(req, res, req.url.split('?')[0]);
  else sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
}

if (process.argv.includes('--cek')) {
  console.log(`Netra: ${await checkKey()}`);
  console.log(`Deepgram: ${await checkDeepgram()}`);
} else {
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      log(`Error server: ${oneLine(error.code || error.message)}`);
      sendError(res, 500, 'SIGI_SERVER', 'Server lokal bermasalah.');
    });
  });
  server.on('upgrade', (req, socket, head) => {
    handleListen(req, socket, head).catch(() => socket.destroy());
  });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${PORT} sudah dipakai. Mungkin Sigi sudah jalan, coba buka http://127.0.0.1:${PORT}. Kalau bukan, matikan program itu atau pakai: PORT=8130 node server.mjs` : error.message);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`Sigi jalan di http://127.0.0.1:${PORT}`);
    for (const [label, name] of [['Netra', 'NETRA_API_KEY'], ['Deepgram', 'DEEPGRAM_API_KEY']]) {
      const key = await readKey(name).catch(() => '');
      console.log(isCleanKey(key) ? `Key ${label} dibaca dari .env (${keyId(key)}).` : `${name} di .env belum diisi atau salah format. Isi, lalu muat ulang halaman.`);
    }
  });
}
