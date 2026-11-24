/*
 * Server lokal Sigi. Membaca API key Netra dan Deepgram dari .env, jadi key tidak perlu diketik di browser.
 *
 *   node server.mjs          -> buka http://127.0.0.1:8123
 *   node server.mjs --cek    -> cek apakah key di .env diterima (tanpa menjalankan AI)
 *
 * Hanya untuk laptop sendiri: server ini cuma menerima koneksi dari komputer yang sama.
 * Situs di GitHub Pages tidak punya server, jadi di sana key tetap diketik di halaman.
 */
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = await realpath(dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT) || 8123;
const ENV_FILE = process.env.SIGI_ENV_FILE || join(ROOT, '.env');
const NETRA_URL = process.env.NETRA_URL || 'https://api.netra.sh/v1'; // diganti hanya saat pengujian
const DEEPGRAM_URL = process.env.DEEPGRAM_URL || 'https://api.deepgram.com'; // diganti hanya saat pengujian
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) || 120_000;
const DEEPGRAM_TIMEOUT_MS = Number(process.env.DEEPGRAM_TIMEOUT_MS) || 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

// Yang sering ikut tersalin dibuang: komentar di belakang, tanda kutip (termasuk kutip miring TextEdit),
// awalan "Bearer" atau "Token", dan nama variabel yang tertempel dua kali.
const cleanKey = (value, name) => value
  .replace(/(^|\s)#.*$/, '')
  .trim()
  .replace(new RegExp(`^(?:${name}\\s*=\\s*)+`), '')
  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
  .replace(/^(?:Bearer|Token)\s+/i, '')
  .trim();

// Sidik jari pendek untuk membedakan key mana yang dipakai. Key aslinya tidak bisa ditebak dari sini.
const keyId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 6);

// Key asli cuma berisi huruf, angka, dan tanda baca biasa. Spasi atau karakter aneh berarti salah tempel.
const isCleanKey = (key) => /^[\x21-\x7e]+$/.test(key);

/* Log: hanya status, lama, ID permintaan, dan pesan error. Isi chat dan key tidak pernah dicatat. */

function log(text) {
  console.log(`[${new Date().toLocaleTimeString('id-ID', { hour12: false })}] ${text}`);
}

const oneLine = (text, key) => {
  const safe = key ? String(text).replaceAll(key, '[key]') : String(text);
  return safe.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').slice(0, 300);
};

// Bentuk pesan error bisa berbeda-beda. Balasan non-JSON (misalnya halaman blokir Cloudflare) diambil teksnya saja.
function upstreamMessage(data, text, key) {
  const found = [data?.error?.message, data?.error, data?.message, data?.err_msg, data?.detail].find((item) => typeof item === 'string' && item);
  if (found) return oneLine(found, key);
  if (data !== null) return 'tanpa pesan';
  const plain = text.slice(0, 20_000).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return oneLine(plain, key).slice(0, 150) || 'balasan kosong';
}

/* Balasan */

function sendJson(res, status, data, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

// code dibaca widget dan playground, supaya pesan errornya bisa membedakan masalah lokal dan masalah Netra.
const sendError = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* Pemeriksaan bersama untuk semua POST /api/... Mengembalikan null kalau permintaan sudah ditolak. */

async function readRequest(req, res, keyName) {
  // Website lain tidak boleh memakai saldo lewat server ini: asalnya harus halaman dari server ini sendiri.
  if (req.headers.origin !== `http://${req.headers.host}`) {
    sendError(res, 403, 'SIGI_BAD_ORIGIN', 'Permintaan hanya boleh dari halaman server lokal ini.');
    return null;
  }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    sendError(res, 415, 'SIGI_BAD_TYPE', 'Isi permintaan harus JSON.');
    return null;
  }
  const raw = await readBody(req);
  if (raw === null) {
    res.setHeader('Connection', 'close');
    sendError(res, 413, 'SIGI_TOO_LARGE', 'Permintaan terlalu besar.');
    return null;
  }
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // ditolak di bawah
  }
  if (!body || typeof body !== 'object') {
    sendError(res, 400, 'SIGI_BAD_BODY', 'Isi permintaan tidak lengkap.');
    return null;
  }
  const key = await readKey(keyName);
  if (!key) {
    sendError(res, 503, 'SIGI_NO_KEY', `${keyName} di file .env masih kosong. Formatnya: ${keyName}=key-kamu.`);
    return null;
  }
  if (!isCleanKey(key)) {
    sendError(res, 503, 'SIGI_BAD_KEY', `${keyName} di file .env berisi spasi atau karakter yang tidak wajar.`);
    return null;
  }
  return { body, key };
}

/* POST /api/chat: meneruskan chat ke Netra memakai key dari .env */

async function handleChat(req, res) {
  const request = await readRequest(req, res, 'NETRA_API_KEY');
  if (!request) return;
  const { body, key } = request;
  if (typeof body.model !== 'string' || !Array.isArray(body.messages)) {
    sendError(res, 400, 'SIGI_BAD_BODY', 'Isi permintaan tidak lengkap.');
    return;
  }

  // Browser menutup halaman atau mengakhiri telepon: permintaan ke Netra ikut dibatalkan.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });

  const startedAt = Date.now();
  const took = () => `${Date.now() - startedAt} ms`;
  try {
    const upstream = await fetch(`${NETRA_URL}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.any([gone.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]),
      redirect: 'error', // key tidak boleh ikut terbawa ke alamat lain
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: body.model,
        messages: body.messages,
        max_tokens: body.max_tokens,
        reasoning: body.reasoning,
      }),
    });
    const text = await upstream.text();
    const id = upstream.headers.get('x-request-id') || '-';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Bukan JSON, biasanya halaman error dari perantara seperti Cloudflare.
    }
    const about = `Netra ${upstream.status} dalam ${took()}, key ${keyId(key)}, id ${id}`;
    if (upstream.ok && data && !data.error) {
      const choice = data.choices?.[0];
      const empty = choice?.message?.content ? '' : `, jawaban kosong (${oneLine(choice?.finish_reason ?? '-', key)})`;
      log(`${about}, token ${data.usage?.total_tokens ?? '-'}${empty}`);
      sendJson(res, upstream.status, data);
      return;
    }
    const message = upstreamMessage(data, text, key);
    const extra = ['retry-after', 'cf-ray'].map((name) => [name, upstream.headers.get(name)]).filter(([, value]) => value)
      .map(([name, value]) => `, ${name} ${oneLine(value, key)}`).join('');
    log(`${about}${extra}: ${message}`);
    // Balasan 200 yang berisi error atau bukan JSON tetap dianggap gagal. NETRA_BLOCKED: yang menjawab bukan
    // API Netra, melainkan perantara di depannya, jadi key belum tentu bermasalah.
    sendJson(res, upstream.ok ? 502 : upstream.status, { error: { code: data === null ? 'NETRA_BLOCKED' : 'NETRA', message } });
  } catch (error) {
    if (gone.signal.aborted) {
      log(`Dibatalkan browser setelah ${took()}`);
      return;
    }
    if (error.name === 'TimeoutError') {
      log(`Netra tidak menjawab setelah ${took()}`);
      sendError(res, 504, 'SIGI_NETRA_TIMEOUT', 'Netra tidak menjawab.');
      return;
    }
    const reason = oneLine(error.cause?.code || error.cause?.message || error.message, key);
    log(`Tidak bisa terhubung ke Netra setelah ${took()}: ${reason}`);
    sendError(res, 502, 'SIGI_NETRA_UNREACHABLE', reason);
  }
}

/* Deepgram. Suara jawaban dan mic sama-sama diteruskan server, jadi key tidak pernah sampai ke browser. */

// Dipakai handleSpeak: kirim ke Deepgram, lalu serahkan balasan suksesnya ke onOk.
async function callDeepgram(res, { label, path, key, body, onOk }) {
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });
  const startedAt = Date.now();
  const about = () => `${label} dalam ${Date.now() - startedAt} ms, key ${keyId(key)}`;
  try {
    const upstream = await fetch(`${DEEPGRAM_URL}${path}`, {
      method: 'POST',
      signal: AbortSignal.any([gone.signal, AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS)]),
      redirect: 'error', // key tidak boleh ikut terbawa ke alamat lain
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (upstream.ok) {
      await onOk(upstream);
      log(`Deepgram ${upstream.status} ${about()}`);
      return;
    }
    const text = await upstream.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Bukan JSON, diambil teksnya saja oleh upstreamMessage.
    }
    const message = upstreamMessage(data, text, key);
    log(`Deepgram ${upstream.status} ${about()}: ${message}`);
    sendJson(res, upstream.status, { error: { code: 'DEEPGRAM', message } });
  } catch (error) {
    // Deepgram yang putus juga menutup res, jadi jenis error-nya ikut dicek.
    if (gone.signal.aborted && (error.name === 'AbortError' || error.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
      log(`Dibatalkan browser: ${about()}`);
      return;
    }
    const reason = error.name === 'TimeoutError' ? 'tidak menjawab' : oneLine(error.cause?.code || error.cause?.message || error.message, key);
    log(`Deepgram gagal, ${about()}: ${reason}`);
    if (res.headersSent) res.destroy(); // suara terputus di tengah: browser harus tahu ini belum selesai
    else sendError(res, 502, 'SIGI_DEEPGRAM_UNREACHABLE', reason);
  }
}

async function handleSpeak(req, res) {
  const request = await readRequest(req, res, 'DEEPGRAM_API_KEY');
  if (!request) return;
  const { body: { text, model, expressivity }, key } = request;
  const level = expressivity ?? 0;
  if (typeof text !== 'string' || !text.trim() || !/^flux-[a-z]+-id$/.test(model) || !Number.isInteger(level) || Math.abs(level) > 2) {
    sendError(res, 400, 'SIGI_BAD_BODY', 'Isi permintaan tidak lengkap.');
    return;
  }
  const params = new URLSearchParams({ model, encoding: 'mp3' });
  if (level !== 0) params.set('expressivity', String(level));
  await callDeepgram(res, {
    label: 'suara', path: `/v2/speak?${params}`, key, body: { text },
    onOk: async (upstream) => {
      res.writeHead(200, { 'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg' });
      await pipeline(Readable.fromWeb(upstream.body), res); // diputar selagi diunduh
    },
  });
}

// Mic: WebSocket dari browser disambungkan ke Deepgram. Server hanya menambah key di jabat tangan awal,
// lalu byte diteruskan apa adanya ke dua arah.
async function handleListen(req, socket, head) {
  socket.on('error', () => socket.destroy());
  const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const [pathname, query = ''] = req.url.split('?');
  if (!HOSTS.has(req.headers.host) || req.headers.origin !== `http://${req.headers.host}`) return refuse('403 Forbidden');
  if (pathname !== '/api/listen' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return refuse('404 Not Found');
  const key = await readKey('DEEPGRAM_API_KEY').catch(() => '');
  if (!isCleanKey(key)) {
    log('Mic ditolak: DEEPGRAM_API_KEY di .env kosong atau salah format.');
    return refuse('503 Service Unavailable');
  }
  if (socket.destroyed) return undefined;

  const headers = { Authorization: `Token ${key}`, Connection: 'Upgrade', Upgrade: 'websocket' };
  for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const url = new URL(`${DEEPGRAM_URL}/v1/listen`);
  url.search = query;
  const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers });
  const timer = setTimeout(() => upstream.destroy(new Error('tidak menjawab')), 10_000);
  const abandon = () => upstream.destroy(); // browser pergi sebelum tersambung
  socket.once('close', abandon);
  upstream.on('error', (error) => {
    clearTimeout(timer);
    if (!socket.destroyed) log(`Mic gagal tersambung ke Deepgram: ${oneLine(error.code || error.message, key)}`);
    refuse('502 Bad Gateway');
  });
  upstream.on('response', async (response) => {
    clearTimeout(timer);
    let text = '';
    for await (const chunk of response) if (text.length < 2000) text += chunk;
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Bukan JSON, diambil teksnya saja oleh upstreamMessage.
    }
    log(`Deepgram ${response.statusCode} mic, key ${keyId(key)}: ${upstreamMessage(data, text, key)}`);
    refuse('502 Bad Gateway');
  });
  upstream.on('upgrade', (response, remote, remoteHead) => {
    clearTimeout(timer);
    socket.off('close', abandon);
    log(`Deepgram mic tersambung, key ${keyId(key)}`);
    const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade'];
    for (const name of ['sec-websocket-accept', 'sec-websocket-extensions']) {
      if (response.headers[name]) lines.push(`${name}: ${response.headers[name]}`);
    }
    socket.setNoDelay(true);
    remote.setNoDelay(true);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
    // Salah satu sisi putus: sisi lain ikut ditutup.
    remote.on('error', () => socket.destroy());
    remote.on('close', () => socket.destroy());
    socket.on('close', () => remote.destroy());
  });
  upstream.end();
  return undefined;
}

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
  res.setHeader('Cache-Control', 'no-store'); // browser selalu memuat versi terbaru
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Nama host lain berarti ada website luar yang menyamar sebagai localhost (DNS rebinding).
  if (!HOSTS.has(req.headers.host)) {
    sendError(res, 403, 'SIGI_BAD_HOST', 'Buka lewat localhost.');
    return;
  }
  const pathname = req.url.split('?')[0];

  if (pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, { netra: isCleanKey(await readKey('NETRA_API_KEY')), deepgram: isCleanKey(await readKey('DEEPGRAM_API_KEY')) });
  } else if (pathname === '/api/chat' && req.method === 'POST') {
    await handleChat(req, res);
  } else if (pathname === '/api/speak' && req.method === 'POST') {
    await handleSpeak(req, res);
  } else if (req.method === 'GET' || req.method === 'HEAD') {
    await handleFile(req, res, pathname);
  } else {
    sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
  }
}

// Cek key lewat /v1/usage: menurut dokumentasi Netra tidak menjalankan AI dan tidak memotong saldo.
async function checkKey() {
  const key = await readKey('NETRA_API_KEY');
  if (!key) return 'NETRA_API_KEY di .env masih kosong.';
  if (!isCleanKey(key)) return 'NETRA_API_KEY di .env berisi spasi atau karakter yang tidak wajar. Salin ulang key-nya.';
  try {
    const response = await fetch(`${NETRA_URL}/usage`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Bukan JSON, jadi bukan jawaban dari API Netra.
    }
    const id = response.headers.get('x-request-id') || '-';
    if (response.ok && data?.total_tokens !== undefined) {
      return `Key ${keyId(key)} diterima Netra. Token terpakai: ${oneLine(data.total_tokens)}. Saldo dan model belum diuji di sini.`;
    }
    return `Key ${keyId(key)}: Netra menjawab ${response.status}: ${upstreamMessage(data, text, key)} (id ${id})`;
  } catch (error) {
    return `Tidak bisa terhubung ke Netra: ${oneLine(error.cause?.code || error.message, key)}`;
  }
}

// Cek key lewat /v1/auth/token: hanya membaca keterangan key, tidak menjalankan AI.
async function checkDeepgram() {
  const key = await readKey('DEEPGRAM_API_KEY');
  if (!key) return 'DEEPGRAM_API_KEY di .env masih kosong.';
  if (!isCleanKey(key)) return 'DEEPGRAM_API_KEY di .env berisi spasi atau karakter yang tidak wajar. Salin ulang key-nya.';
  try {
    const response = await fetch(`${DEEPGRAM_URL}/v1/auth/token`, {
      headers: { Authorization: `Token ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // Bukan JSON, jadi bukan jawaban dari API Deepgram.
    }
    if (response.ok && data) return `Key ${keyId(key)} diterima Deepgram. Saldo dan suara belum diuji di sini.`;
    if (response.ok) return `Key ${keyId(key)}: balasan Deepgram tidak dikenali.`;
    return `Key ${keyId(key)}: Deepgram menjawab ${response.status}: ${upstreamMessage(data, text, key)}`;
  } catch (error) {
    return `Tidak bisa terhubung ke Deepgram: ${oneLine(error.cause?.code || error.message, key)}`;
  }
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
