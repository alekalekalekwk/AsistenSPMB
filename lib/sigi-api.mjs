/*
 * API Sigi: dipakai bersama oleh server lokal (server.mjs) dan Vercel (folder api/).
 * Key hanya dibaca di sini dan tidak pernah dikirim ke browser.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { callSupabaseRpc, checkSupabase as checkSupabaseConn, logChatTurn, logWidgetEvent, readSupabaseConfig } from './supabase.mjs';
import { getSessionUser, handleV1Api } from './sigi-v1.mjs';
import { configureStore, getSchool } from './store.mjs';

const NETRA_URL = process.env.NETRA_URL || 'https://api.netra.sh/v1'; // diganti hanya saat pengujian
const DEEPGRAM_URL = process.env.DEEPGRAM_URL || 'https://api.deepgram.com'; // diganti hanya saat pengujian
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) || 120_000;
const DEEPGRAM_TIMEOUT_MS = Number(process.env.DEEPGRAM_TIMEOUT_MS) || 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOKENS = 8192; // batas atas supaya satu permintaan tidak menghabiskan saldo

/* Pengaturan per tempat jalan: server lokal tanpa password, Vercel dengan password. */

let readKey = async () => '';
let isAllowedHost = () => false;
let originFor = () => '';
let needsPassword = true;

export function configure(options) {
  ({ readKey, isAllowedHost, originFor, needsPassword } = options);
  configureStore({ readKey, isCleanKey });
}

const sameOrigin = (req) => isAllowedHost(req.headers.host) && req.headers.origin === originFor(req.headers.host);

/* Password (hanya di Vercel). Tanpa SIGI_PASSWORD yang cukup panjang, semua jalur tertutup. */

const MIN_PASSWORD = 12;
const SESSION_SECONDS = 12 * 60 * 60;
const COOKIE = '__Host-sigi';
const password = () => (process.env.SIGI_PASSWORD || '').trim();
const passwordReady = () => password().length >= MIN_PASSWORD;
const sha = (text) => createHash('sha256').update(text).digest();
const sign = (expires) => createHmac('sha256', sha(`sigi-sesi:${password()}`)).update(String(expires)).digest('hex');

// Cookie berisi waktu habis dan tanda tangan. Mengganti SIGI_PASSWORD otomatis mengeluarkan semua orang.
function isLoggedIn(req) {
  if (!needsPassword) return true;
  if (!passwordReady()) return false;
  const found = (req.headers.cookie || '').split(/;\s*/).find((part) => part.startsWith(`${COOKIE}=`));
  const match = found?.slice(COOKIE.length + 1).match(/^(\d{1,12})\.([0-9a-f]{64})$/);
  if (!match || Number(match[1]) * 1000 < Date.now()) return false;
  return timingSafeEqual(Buffer.from(sign(match[1])), Buffer.from(match[2]));
}

async function handleLogin(req, res) {
  const body = await readJson(req, res);
  if (!body) return;
  if (!passwordReady()) {
    sendError(res, 503, 'SIGI_NO_PASSWORD', `SIGI_PASSWORD belum diisi, atau kurang dari ${MIN_PASSWORD} karakter.`);
    return;
  }
  await new Promise((done) => setTimeout(done, 1000)); // memperlambat tebak-tebakan password
  if (typeof body.password !== 'string' || !timingSafeEqual(sha(body.password.trim()), sha(password()))) {
    log('Password salah');
    sendError(res, 401, 'SIGI_WRONG_PASSWORD', 'Password salah.');
    return;
  }
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${expires}.${sign(expires)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict` });
}

// Yang sering ikut tersalin dibuang: komentar di belakang, tanda kutip (termasuk kutip miring TextEdit),
// awalan "Bearer" atau "Token", dan nama variabel yang tertempel dua kali.
export const cleanKey = (value, name) => value
  .replace(/(^|\s)#.*$/, '')
  .trim()
  .replace(new RegExp(`^(?:${name}\\s*=\\s*)+`), '')
  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
  .replace(/^(?:Bearer|Token)\s+/i, '')
  .trim();

// Sidik jari pendek untuk membedakan key mana yang dipakai. Key aslinya tidak bisa ditebak dari sini.
export const keyId = (key) => createHash('sha256').update(key).digest('hex').slice(0, 6);

// Key asli cuma berisi huruf, angka, dan tanda baca biasa. Spasi atau karakter aneh berarti salah tempel.
export const isCleanKey = (key) => /^[\x21-\x7e]+$/.test(key);

/* Log: hanya status, lama, ID permintaan, dan pesan error. Isi chat dan key tidak pernah dicatat. */

export function log(text) {
  console.log(`[${new Date().toLocaleTimeString('id-ID', { hour12: false })}] ${text}`);
}

export const oneLine = (text, key) => {
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
export const sendError = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

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

async function readJson(req, res) {
  // Website lain tidak boleh memakai saldo lewat server ini: asalnya harus halaman dari server ini sendiri.
  if (!sameOrigin(req)) {
    sendError(res, 403, 'SIGI_BAD_ORIGIN', 'Permintaan hanya boleh dari halaman Sigi ini.');
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
  return body;
}

async function readRequest(req, res, keyName) {
  if (!isLoggedIn(req)) {
    sendError(res, 401, 'SIGI_LOGIN', 'Sesi habis. Masukkan password lagi.');
    return null;
  }
  const body = await readJson(req, res);
  if (!body) return null;
  const key = await readKey(keyName);
  if (!key) {
    sendError(res, 503, 'SIGI_NO_KEY', `${keyName} masih kosong. Formatnya: ${keyName}=key-kamu.`);
    return null;
  }
  if (!isCleanKey(key)) {
    sendError(res, 503, 'SIGI_BAD_KEY', `${keyName} berisi spasi atau karakter yang tidak wajar.`);
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
  const latestUserMessage = [...body.messages].reverse().find((item) => item?.role === 'user' && typeof item.content === 'string')?.content || null;
  const supabaseConfig = await readSupabaseConfig(readKey, isCleanKey);
  try {
    const upstream = await fetch(`${NETRA_URL}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.any([gone.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]),
      redirect: 'error', // key tidak boleh ikut terbawa ke alamat lain
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: body.model,
        messages: body.messages,
        max_tokens: Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? Math.min(body.max_tokens, MAX_TOKENS) : 2048,
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
    const latencyMs = Date.now() - startedAt;
    const about = `Netra ${upstream.status} dalam ${latencyMs} ms, key ${keyId(key)}, id ${id}`;
    if (upstream.ok && data && !data.error) {
      const choice = data.choices?.[0];
      const replyText = choice?.message?.content?.trim() || null;
      const empty = replyText ? '' : `, jawaban kosong (${oneLine(choice?.finish_reason ?? '-', key)})`;
      log(`${about}, token ${data.usage?.total_tokens ?? '-'}${empty}`);
      await logChatTurn(supabaseConfig, log, oneLine, {
        meta: body.meta,
        userContent: replyText ? latestUserMessage : null,
        assistantContent: replyText,
        model: body.model,
        requestId: id === '-' ? null : id,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        totalTokens: data.usage?.total_tokens,
        latencyMs,
        httpStatus: upstream.status,
        errorCode: replyText ? null : 'NETRA_EMPTY',
      });
      sendJson(res, upstream.status, data);
      return;
    }
    const message = upstreamMessage(data, text, key);
    const errorCode = data === null ? 'NETRA_BLOCKED' : 'NETRA';
    const responseStatus = upstream.ok ? 502 : upstream.status;
    const extra = ['retry-after', 'cf-ray'].map((name) => [name, upstream.headers.get(name)]).filter(([, value]) => value)
      .map(([name, value]) => `, ${name} ${oneLine(value, key)}`).join('');
    log(`${about}${extra}: ${message}`);
    await logChatTurn(supabaseConfig, log, oneLine, {
      meta: body.meta,
      userContent: null,
      assistantContent: null,
      model: body.model,
      requestId: id === '-' ? null : id,
      latencyMs,
      httpStatus: responseStatus,
      errorCode,
    });
    // Balasan 200 yang berisi error atau bukan JSON tetap dianggap gagal. NETRA_BLOCKED: yang menjawab bukan
    // API Netra, melainkan perantara di depannya, jadi key belum tentu bermasalah.
    sendJson(res, responseStatus, { error: { code: errorCode, message } });
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    if (gone.signal.aborted) {
      log(`Dibatalkan browser setelah ${latencyMs} ms`);
      return;
    }
    if (error.name === 'TimeoutError') {
      log(`Netra tidak menjawab setelah ${latencyMs} ms`);
      await logChatTurn(supabaseConfig, log, oneLine, {
        meta: body.meta,
        userContent: null,
        assistantContent: null,
        model: body.model,
        latencyMs,
        httpStatus: 504,
        errorCode: 'SIGI_NETRA_TIMEOUT',
      });
      sendError(res, 504, 'SIGI_NETRA_TIMEOUT', 'Netra tidak menjawab.');
      return;
    }
    const reason = oneLine(error.cause?.code || error.cause?.message || error.message, key);
    log(`Tidak bisa terhubung ke Netra setelah ${latencyMs} ms: ${reason}`);
    await logChatTurn(supabaseConfig, log, oneLine, {
      meta: body.meta,
      userContent: null,
      assistantContent: null,
      model: body.model,
      latencyMs,
      httpStatus: 502,
      errorCode: 'SIGI_NETRA_UNREACHABLE',
    });
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
export async function handleListen(req, socket, head) {
  socket.on('error', () => socket.destroy());
  const refuse = (status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  const [pathname, query = ''] = req.url.split('?');
  if (!sameOrigin(req)) return refuse('403 Forbidden');
  if (!isLoggedIn(req)) {
    log('Mic ditolak: belum masuk atau sesi habis');
    return refuse('401 Unauthorized');
  }
  if (pathname !== '/api/listen' || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return refuse('404 Not Found');
  const key = await readKey('DEEPGRAM_API_KEY').catch(() => '');
  if (!isCleanKey(key)) {
    log('Mic ditolak: DEEPGRAM_API_KEY kosong atau salah format.');
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

async function handleEvents(req, res) {
  if (!isLoggedIn(req)) {
    sendError(res, 401, 'SIGI_LOGIN', 'Sesi habis. Masukkan password lagi.');
    return;
  }
  const body = await readJson(req, res);
  if (!body) return;
  const supabaseConfig = await readSupabaseConfig(readKey, isCleanKey);
  const result = await logWidgetEvent(supabaseConfig, log, oneLine, body);
  if (result.invalid) {
    sendError(res, 400, 'SIGI_BAD_BODY', 'Nama event tidak dikenali.');
    return;
  }
  sendJson(res, 200, { ok: true, skipped: result.skipped === true });
}

async function handleAnalytics(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const schoolId = (url.searchParams.get('school') || 'wikrama').trim().slice(0, 64) || 'wikrama';
  if (!isLoggedIn(req)) {
    const sessionUser = await getSessionUser(req).catch(() => null);
    const owned = sessionUser ? await getSchool(schoolId, sessionUser.id).catch(() => null) : null;
    if (!owned) {
      sendError(res, 401, 'SIGI_LOGIN', 'Masukkan password dulu untuk membuka ringkasan percakapan.');
      return;
    }
  }
  const supabaseConfig = await readSupabaseConfig(readKey, isCleanKey);
  if (!supabaseConfig.configured) {
    sendJson(res, 200, { configured: false });
    return;
  }
  const rawDays = Number(url.searchParams.get('days'));
  const days = Number.isInteger(rawDays) && rawDays >= 0 && rawDays <= 3650 ? rawDays : 30;
  const periodLabel = (url.searchParams.get('period') || '').trim().slice(0, 32) || null;
  try {
    const analytics = await callSupabaseRpc(supabaseConfig, 'get_school_analytics', {
      p_school_id: schoolId,
      p_days: days,
      p_period_label: periodLabel,
    });
    sendJson(res, 200, { configured: true, ...analytics });
  } catch (error) {
    const reason = oneLine(error.message, supabaseConfig.key);
    log(`Gagal mengambil analytics Supabase: ${reason}`);
    sendError(res, 502, 'SIGI_SUPABASE', `Gagal membaca analytics dari Supabase (${reason}).`);
  }
}

/* Pintu masuk. Mengembalikan false kalau alamatnya bukan milik API. */

export async function handleApi(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Nama host lain berarti ada website luar yang menyamar (DNS rebinding).
  if (!isAllowedHost(req.headers.host)) {
    sendError(res, 403, 'SIGI_BAD_HOST', 'Alamat tidak dikenal.');
    return true;
  }
  if (await handleV1Api(req, res, { readKey, isCleanKey, isLoggedIn, sameOrigin, originFor, log, oneLine, upstreamMessage })) {
    return true;
  }
  const route = `${req.method} ${req.url.split('?')[0]}`;
  if (route === 'GET /api/status') {
    const open = isLoggedIn(req);
    const supabase = open ? (await readSupabaseConfig(readKey, isCleanKey)).configured : false;
    sendJson(res, 200, {
      login: !open,
      netra: open && isCleanKey(await readKey('NETRA_API_KEY')),
      deepgram: open && isCleanKey(await readKey('DEEPGRAM_API_KEY')),
      supabase,
    });
  } else if (route === 'POST /api/chat') await handleChat(req, res);
  else if (route === 'POST /api/speak') await handleSpeak(req, res);
  else if (route === 'POST /api/events') await handleEvents(req, res);
  else if (route === 'GET /api/analytics') await handleAnalytics(req, res);
  else if (route === 'POST /api/login' && needsPassword) await handleLogin(req, res);
  else return false;
  return true;
}

export const checkSupabase = () => checkSupabaseConn(readKey, isCleanKey, keyId, oneLine);

/* node server.mjs --cek */

// Cek key lewat /v1/usage: menurut dokumentasi Netra tidak menjalankan AI dan tidak memotong saldo.
export async function checkKey() {
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
export async function checkDeepgram() {
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
