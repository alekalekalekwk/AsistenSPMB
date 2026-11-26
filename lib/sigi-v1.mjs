/*
 * Mesin API Sigi v1 (Multi-Sekolah berbasis API Key) + Endpoint Manajemen Dashboard.
 *
 * - /api/v1/widget/config : mengambil konfigurasi publik widget (Publishable Key + CORS Allowlist)
 * - /api/v1/chat          : chat lintas-domain/backend (Publishable Key atau Secret Key)
 * - /api/v1/speak         : TTS Deepgram Flux (jika voiceEnabled = true)
 * - /api/v1/voice-token   : token sementara Deepgram berumur pendek untuk STT di Vercel
 * - /api/dashboard/*      : manajemen sekolah, template konteks, allowlist, dan API key
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MAX_CONTEXT_CHARS,
  authenticateUser,
  consumeChatUsage,
  createApiKey,
  createLead,
  listLeads,
  maskLead,
  resolveSchoolId,
  updateLeadStatus,
  validateLead,
  findActiveKey,
  getSchool,
  getSessionSecret,
  getUserById,
  listApiKeys,
  listSchools,
  normalizeOrigin,
  registerUserWithSchool,
  revokeApiKey,
  touchApiKeyUsage,
  updateSchool,
} from './store.mjs';
import { cleanUuid, logChatTurn, readSupabaseConfig } from './supabase.mjs';

const NETRA_URL = process.env.NETRA_URL || 'https://api.netra.sh/v1';
const DEEPGRAM_URL = process.env.DEEPGRAM_URL || 'https://api.deepgram.com';
const DEFAULT_MODEL = process.env.SIGI_DEFAULT_MODEL || 'deepseek/deepseek-v4.1-flash';
const CHAT_TIMEOUT_MS = Number(process.env.CHAT_TIMEOUT_MS) || 120_000;
const DEEPGRAM_TIMEOUT_MS = Number(process.env.DEEPGRAM_TIMEOUT_MS) || 60_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2000;
const MAX_OUTPUT_TOKENS = 2048;

// Rate limit ringan per (schoolId + IP): maksimal 20 permintaan per 60 detik.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQUESTS = Number(process.env.SIGI_RATE_LIMIT) || 20;
const rateBuckets = new Map();

const CALL_RULES = [
  'Namamu Sigi.',
  'Calon murid atau orang tua sedang menelepon, jadi jawabanmu akan dibacakan dengan suara.',
  'Bicaralah seperti CS sekolah yang ramah sedang ngobrol di telepon, bukan seperti membaca pengumuman.',
  'Pakai kalimat pendek, kira-kira paling banyak lima belas kata per kalimat, dan beri koma di tempat orang biasanya mengambil napas.',
  'Sebut "Kak" paling banyak sekali dalam satu jawaban.',
  'Jawab paling banyak tiga kalimat dan langsung ke intinya. Kalau infonya panjang, sebut dua atau tiga hal yang paling penting, lalu tawarkan untuk melanjutkan.',
  'Jangan membuka jawaban dengan sapaan atau ucapan terima kasih sudah menunggu, karena aplikasi sudah mengucapkannya.',
  'Tulis angka, jam, tanggal, dan biaya dengan huruf. Jangan membacakan alamat website atau email huruf demi huruf.',
  'Jangan memakai Markdown, daftar, tanda bintang, tautan, atau simbol lain.',
].join('\n');

/* Helper umum */

function sendJson(res, status, data, headers = {}) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(data));
}

function sendError(res, status, code, message, headers = {}) {
  sendJson(res, status, { error: { code, message } }, headers);
}

function corsHeaders(origin) {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sigi-Key',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

async function readJsonBody(req, res, headers = {}) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
    sendError(res, 415, 'SIGI_BAD_TYPE', 'Isi permintaan harus JSON (Content-Type: application/json).', headers);
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.setHeader('Connection', 'close');
      sendError(res, 413, 'SIGI_TOO_LARGE', 'Permintaan terlalu besar.', headers);
      return null;
    }
    chunks.push(chunk);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    // ditolak di bawah
  }
  if (!parsed || typeof parsed !== 'object') {
    sendError(res, 400, 'SIGI_BAD_BODY', 'Format JSON tidak valid.', headers);
    return null;
  }
  return parsed;
}

function extractApiKey(req) {
  const headerKey = req.headers['x-sigi-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) return headerKey.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  return '';
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Form calon pendaftar: paling banyak 5 kiriman per 10 menit per (sekolah + IP), supaya tidak dipakai spam.
const LEAD_WINDOW_MS = 10 * 60_000;
const LEAD_MAX_REQUESTS = 5;
const leadBuckets = new Map();

function checkLeadRateLimit(schoolId, ip) {
  const now = Date.now();
  const bucketKey = `${schoolId}:${ip}`;
  const list = (leadBuckets.get(bucketKey) || []).filter((ts) => now - ts < LEAD_WINDOW_MS);
  if (list.length >= LEAD_MAX_REQUESTS) {
    leadBuckets.set(bucketKey, list);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((LEAD_WINDOW_MS - (now - list[0])) / 1000)) };
  }
  list.push(now);
  leadBuckets.set(bucketKey, list);
  return { allowed: true, retryAfter: 0 };
}

function checkRateLimit(schoolId, ip) {
  const now = Date.now();
  const bucketKey = `${schoolId}:${ip}`;
  const list = (rateBuckets.get(bucketKey) || []).filter((ts) => now - ts < RATE_WINDOW_MS);
  if (list.length >= RATE_MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - list[0])) / 1000));
    rateBuckets.set(bucketKey, list);
    return { allowed: false, retryAfter };
  }
  list.push(now);
  rateBuckets.set(bucketKey, list);
  return { allowed: true, retryAfter: 0 };
}

function isOriginAllowed(origin, school, selfOrigin) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (selfOrigin && normalized === selfOrigin.toLowerCase()) return true;
  return (school.allowedOrigins || []).some((entry) => entry === '*' || entry === normalized);
}

/* Guardrail sistem Sigi + konteks milik sekolah (disusun sepenuhnya di server). */
export function compileSchoolContext(school) {
  const parts = [`=== INFO ${String(school.name || 'SEKOLAH').toUpperCase()} ===`];
  for (const page of school.pages || []) {
    if (page.body && page.body.trim()) {
      parts.push(`[${(page.title || 'Tanpa judul').trim()}]\n${page.body.trim()}`);
    }
  }
  for (const doc of school.documents || []) {
    if (doc.text && doc.text.trim()) {
      parts.push(`[Dokumen: ${doc.name}]\n${doc.text.trim()}`);
    }
  }
  return parts.join('\n\n').slice(0, MAX_CONTEXT_CHARS);
}

export function buildServerSystemPrompt(school, { forCall = false } = {}) {
  const context = compileSchoolContext(school);
  const rules = [
    `Kamu adalah asisten customer service SPMB untuk ${school.name}.`,
    'Kamu ramah, sopan, dan membantu calon murid maupun orang tua/wali.',
    'Jawab pertanyaan HANYA berdasarkan informasi di bagian KONTEKS di bawah ini.',
    'Jika informasi tidak tersedia di KONTEKS, katakan dengan jujur bahwa kamu belum punya informasi tersebut, lalu arahkan penanya menghubungi CS SPMB sekolah dan sebutkan kontak resmi yang ada di KONTEKS.',
    'DILARANG mengarang biaya, kuota, jadwal, beasiswa, nama guru, atau kebijakan sekolah.',
    'DILARANG meminta data sensitif seperti NIK, NISN, nomor KK, password, atau nomor rekening melalui percakapan.',
    `Tolak dengan sopan pertanyaan yang tidak berkaitan dengan ${school.name} dan kembalikan percakapan ke topik sekolah.`,
    'Jawab singkat, jelas, dan mudah dibaca.',
    'Boleh memakai Markdown sederhana: **tebal** untuk info penting, daftar poin atau bernomor untuk langkah/pilihan, dan tautan [teks](https://...) hanya untuk alamat yang ada di KONTEKS. Jangan memakai tabel, judul (#), atau blok kode.',
  ];
  const base = `${rules.join('\n')}\n\nKONTEKS:\n${context}`;
  return forCall ? `${base}\n\n${CALL_RULES}` : base;
}

/* Validasi API Key + Origin Allowlist + Rate Limit */
async function authenticateV1(req, res, ctx, { requirePublishable = false, checkQuota = false, includeContext = false } = {}) {
  const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const selfOrigin = ctx.originFor(req.headers.host);
  const rawKey = extractApiKey(req);

  if (!rawKey) {
    sendError(res, 401, 'SIGI_INVALID_KEY', 'API key tidak disertakan. Kirim lewat header X-Sigi-Key atau Authorization: Bearer.', corsHeaders(rawOrigin));
    return null;
  }

  let found;
  try {
    found = await findActiveKey(rawKey, { includeContext });
  } catch (error) {
    sendError(res, 503, error.code || 'SIGI_DB_ERROR', error.message || 'Gagal memvalidasi API key di database.', corsHeaders(rawOrigin));
    return null;
  }
  if (!found) {
    sendError(res, 401, 'SIGI_INVALID_KEY', 'API key tidak valid atau sudah dicabut.', corsHeaders(rawOrigin));
    return null;
  }

  const { apiKey, school } = found;
  if (requirePublishable && apiKey.kind !== 'publishable') {
    sendError(res, 403, 'SIGI_WRONG_KEY_KIND', 'Endpoint konfigurasi widget hanya menerima Publishable Key (sg_pk_...).', corsHeaders(rawOrigin));
    return null;
  }

  if (school.plan === 'suspended') {
    sendError(res, 403, 'SIGI_SCHOOL_SUSPENDED', 'Layanan chatbot untuk sekolah ini sedang dinonaktifkan sementara.', corsHeaders(rawOrigin));
    return null;
  }

  // Keamanan dua jenis key:
  // - Publishable Key (sg_pk_...): jika dipanggil dari browser (ada header Origin), wajib cocok dengan allowedOrigins.
  // - Secret Key (sg_sk_...): khusus backend server-to-server; ditolak jika dipakai lintas-domain dari browser.
  if (apiKey.kind === 'secret') {
    if (rawOrigin && (!selfOrigin || normalizeOrigin(rawOrigin) !== selfOrigin.toLowerCase())) {
      sendError(res, 403, 'SIGI_SECRET_IN_BROWSER', 'Secret key (sg_sk_...) hanya boleh dipanggil dari backend server, bukan langsung dari browser. Gunakan Publishable key (sg_pk_...) untuk browser.', corsHeaders(rawOrigin));
      return null;
    }
  } else if (rawOrigin) {
    if (!isOriginAllowed(rawOrigin, school, selfOrigin)) {
      sendError(res, 403, 'SIGI_ORIGIN_DENIED', `Domain ${rawOrigin} belum terdaftar di Domain Allowlist sekolah ini.`, corsHeaders(rawOrigin));
      return null;
    }
  }

  const headers = rawOrigin ? corsHeaders(rawOrigin) : {};

  if (checkQuota) {
    const rate = checkRateLimit(school.id, clientIp(req));
    if (!rate.allowed) {
      sendError(res, 429, 'SIGI_RATE_LIMITED', 'Terlalu banyak permintaan dalam satu menit. Coba lagi sebentar.', { ...headers, 'Retry-After': String(rate.retryAfter) });
      return null;
    }
    if ((school.chatUsed || 0) >= (school.chatQuota || 0)) {
      sendError(res, 429, 'SIGI_QUOTA_EXCEEDED', `Kuota percakapan sekolah sudah habis (${school.chatUsed}/${school.chatQuota}). Hubungi Sigi untuk menambah kuota.`, headers);
      return null;
    }
  }

  return { apiKey, school, headers };
}

/* ==================== Handler /api/v1/* ==================== */

async function handleWidgetConfig(req, res, ctx) {
  const auth = await authenticateV1(req, res, ctx, { requirePublishable: true });
  if (!auth) return;
  const { school, headers } = auth;
  sendJson(res, 200, {
    schoolId: school.id,
    schoolName: school.name,
    colors: school.theme,
    greeting: school.greeting,
    suggestions: (school.suggestions || []).filter((q) => String(q).trim()),
    voiceEnabled: Boolean(school.voiceEnabled),
    voice: school.voiceId || 'flux-fitri-id',
    expressivity: Number.isInteger(school.voiceExpressivity) ? school.voiceExpressivity : 1,
    plan: school.plan,
    leadsEnabled: school.plan !== 'suspended',
    quotaRemaining: Math.max(0, (school.chatQuota || 0) - (school.chatUsed || 0)),
  }, headers);
}

async function handleV1Chat(req, res, ctx) {
  const auth = await authenticateV1(req, res, ctx, { checkQuota: true, includeContext: true });
  if (!auth) return;
  const { apiKey, school, headers } = auth;

  const body = await readJsonBody(req, res, headers);
  if (!body) return;

  // Terima baik { messages: [...] } maupun bentuk ringkas { message: "..." } agar praktis untuk REST API sekolah.
  let rawMessages = [];
  if (Array.isArray(body.messages)) {
    rawMessages = body.messages;
  } else if (typeof body.message === 'string' && body.message.trim()) {
    rawMessages = [{ role: 'user', content: body.message }];
  }

  // Filter ketat: klien TIDAK boleh menyisipkan role "system".
  const cleanMessages = rawMessages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.trim().slice(0, MAX_MESSAGE_CHARS) }));

  if (cleanMessages.length === 0 || cleanMessages[cleanMessages.length - 1].role !== 'user') {
    sendError(res, 400, 'SIGI_BAD_BODY', 'Kirim minimal satu pesan pengguna di field "messages" atau "message".', headers);
    return;
  }

  const netraKey = await ctx.readKey('NETRA_API_KEY');
  if (!netraKey || !ctx.isCleanKey(netraKey)) {
    sendError(res, 503, 'SIGI_NO_KEY', 'NETRA_API_KEY di server Sigi belum dikonfigurasi.', headers);
    return;
  }

  // Periksa dan potong kuota secara atomik di database Supabase sebelum memanggil AI.
  const quotaCheck = await consumeChatUsage(school.id, apiKey.id);
  if (!quotaCheck?.allowed) {
    if (quotaCheck?.reason === 'school_suspended') {
      sendError(res, 403, 'SIGI_SCHOOL_SUSPENDED', 'Layanan chatbot untuk sekolah ini sedang dinonaktifkan sementara.', headers);
    } else {
      sendError(res, 429, 'SIGI_QUOTA_EXCEEDED', `Kuota percakapan sekolah sudah habis (${quotaCheck?.chat_used ?? school.chatUsed}/${quotaCheck?.chat_quota ?? school.chatQuota}). Hubungi Sigi untuk menambah kuota.`, headers);
    }
    return;
  }

  const forCall = body.mode === 'call';
  const systemPrompt = buildServerSystemPrompt(school, { forCall });
  const payload = {
    model: DEFAULT_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, ...cleanMessages],
    max_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { enabled: true },
  };

  const latestUserMessage = cleanMessages[cleanMessages.length - 1].content;
  const supabaseConfig = await readSupabaseConfig(ctx.readKey, ctx.isCleanKey);
  const analyticsMeta = {
    schoolId: school.id,
    schoolName: school.name,
    periodLabel: school.activePeriodLabel || '2027-2028',
    conversationId: cleanUuid(body.conversationId) || randomUUID(),
    visitorSessionId: cleanUuid(body.visitorSessionId) || randomUUID(),
    channel: forCall ? 'call' : 'chat',
    inputSource: forCall ? 'call_voice' : 'typed',
  };

  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });

  const startedAt = Date.now();
  try {
    const upstream = await fetch(`${NETRA_URL}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.any([gone.signal, AbortSignal.timeout(CHAT_TIMEOUT_MS)]),
      redirect: 'error',
      headers: { Authorization: `Bearer ${netraKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await upstream.text();
    const requestId = upstream.headers.get('x-request-id') || null;
    const latencyMs = Date.now() - startedAt;
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      // non-JSON
    }

    if (upstream.ok && data && !data.error) {
      const reply = data.choices?.[0]?.message?.content?.trim();
      if (!reply) {
        sendError(res, 502, 'SIGI_EMPTY_REPLY', 'Asisten tidak mengembalikan jawaban. Coba kirim ulang.', headers);
        return;
      }
      const totalTokens = data.usage?.total_tokens ?? 0;
      // Catat ke Supabase di background: tidak memblokir respons ke browser.
      logChatTurn(supabaseConfig, ctx.log, ctx.oneLine, {
        meta: analyticsMeta,
        userContent: latestUserMessage,
        assistantContent: reply,
        model: DEFAULT_MODEL,
        requestId,
        promptTokens: data.usage?.prompt_tokens,
        completionTokens: data.usage?.completion_tokens,
        totalTokens,
        latencyMs,
        httpStatus: 200,
        errorCode: null,
        apiKeyId: apiKey.id,
        endpoint: 'chat',
      }).catch(() => {});
      ctx.log(`v1/chat ${school.slug} (${apiKey.kind}) 200 dalam ${latencyMs} ms, token ${totalTokens}`);
      sendJson(res, 200, {
        reply,
        model: DEFAULT_MODEL,
        usage: {
          totalTokens,
          chatUsed: quotaCheck.chat_used,
          chatQuota: quotaCheck.chat_quota,
        },
      }, headers);
      return;
    }

    const message = ctx.upstreamMessage(data, text, netraKey);
    const errorCode = data === null ? 'NETRA_BLOCKED' : 'NETRA';
    const responseStatus = upstream.ok ? 502 : upstream.status;
    // Catat error ke Supabase di background: tidak memblokir respons error ke browser.
    logChatTurn(supabaseConfig, ctx.log, ctx.oneLine, {
      meta: analyticsMeta,
      userContent: null,
      assistantContent: null,
      model: DEFAULT_MODEL,
      requestId,
      latencyMs,
      httpStatus: responseStatus,
      errorCode,
      apiKeyId: apiKey.id,
      endpoint: 'chat',
    }).catch(() => {});
    ctx.log(`v1/chat ${school.slug} gagal ${upstream.status}: ${message}`);
    sendError(res, responseStatus, errorCode, message, headers);
  } catch (error) {
    if (gone.signal.aborted) return;
    if (error.name === 'TimeoutError') {
      sendError(res, 504, 'SIGI_NETRA_TIMEOUT', 'Server AI terlalu lama menjawab. Coba lagi.', headers);
      return;
    }
    sendError(res, 502, 'SIGI_NETRA_UNREACHABLE', 'Tidak bisa terhubung ke server AI Netra.', headers);
  }
}

async function handleV1Speak(req, res, ctx) {
  const auth = await authenticateV1(req, res, ctx);
  if (!auth) return;
  const { apiKey, school, headers } = auth;

  if (!school.voiceEnabled) {
    sendError(res, 403, 'SIGI_VOICE_DISABLED', 'Fitur suara dan telepon tidak diaktifkan untuk sekolah ini.', headers);
    return;
  }

  const body = await readJsonBody(req, res, headers);
  if (!body) return;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const model = typeof body.model === 'string' && /^flux-[a-z]+-id$/.test(body.model) ? body.model : (school.voiceId || 'flux-fitri-id');
  const level = Number.isInteger(body.expressivity) && Math.abs(body.expressivity) <= 2 ? body.expressivity : (school.voiceExpressivity ?? 1);

  if (!text) {
    sendError(res, 400, 'SIGI_BAD_BODY', 'Field "text" wajib diisi.', headers);
    return;
  }

  const dgKey = await ctx.readKey('DEEPGRAM_API_KEY');
  if (!dgKey || !ctx.isCleanKey(dgKey)) {
    sendError(res, 503, 'SIGI_NO_KEY', 'DEEPGRAM_API_KEY di server Sigi belum dikonfigurasi.', headers);
    return;
  }

  const params = new URLSearchParams({ model, encoding: 'mp3' });
  if (level !== 0) params.set('expressivity', String(level));

  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });

  try {
    const upstream = await fetch(`${DEEPGRAM_URL}/v2/speak?${params}`, {
      method: 'POST',
      signal: AbortSignal.any([gone.signal, AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS)]),
      redirect: 'error',
      headers: { Authorization: `Token ${dgKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 2000) }),
    });
    if (upstream.ok && upstream.body) {
      res.writeHead(200, { ...headers, 'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg' });
      await pipeline(Readable.fromWeb(upstream.body), res);
      await touchApiKeyUsage(apiKey.id);
      return;
    }
    const errText = await upstream.text();
    let errData = null;
    try { errData = JSON.parse(errText); } catch { /* ignore */ }
    sendError(res, upstream.status, 'DEEPGRAM', ctx.upstreamMessage(errData, errText, dgKey), headers);
  } catch (error) {
    if (gone.signal.aborted) return;
    if (res.headersSent) res.destroy();
    else sendError(res, 502, 'SIGI_DEEPGRAM_UNREACHABLE', 'Gagal terhubung ke layanan suara Deepgram.', headers);
  }
}

async function handleV1VoiceToken(req, res, ctx) {
  const auth = await authenticateV1(req, res, ctx);
  if (!auth) return;
  const { apiKey, school, headers } = auth;

  if (!school.voiceEnabled) {
    sendError(res, 403, 'SIGI_VOICE_DISABLED', 'Fitur suara dan telepon tidak diaktifkan untuk sekolah ini.', headers);
    return;
  }

  const dgKey = await ctx.readKey('DEEPGRAM_API_KEY');
  if (!dgKey || !ctx.isCleanKey(dgKey)) {
    sendError(res, 503, 'SIGI_NO_KEY', 'DEEPGRAM_API_KEY di server Sigi belum dikonfigurasi.', headers);
    return;
  }

  try {
    // Minta token JWT sementara (60 detik) dari Deepgram agar browser bisa langsung WebSocket di Vercel tanpa membocorkan key utama.
    const upstream = await fetch(`${DEEPGRAM_URL}/v1/auth/grant`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
      headers: { Authorization: `Token ${dgKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: 60 }),
    });
    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* ignore */ }

    if (upstream.ok && data?.access_token) {
      await touchApiKeyUsage(apiKey.id);
      sendJson(res, 200, {
        token: data.access_token,
        expiresIn: data.expires_in || 60,
        authScheme: 'bearer',
      }, headers);
      return;
    }

    const msg = ctx.upstreamMessage(data, text, dgKey);
    ctx.log(`v1/voice-token Deepgram ${upstream.status}: ${msg}`);
    sendError(res, 502, 'SIGI_VOICE_TOKEN_UNAVAILABLE', `Token suara sementara belum tersedia dari Deepgram (${msg}).`, headers);
  } catch {
    sendError(res, 502, 'SIGI_DEEPGRAM_UNREACHABLE', 'Tidak bisa terhubung ke Deepgram untuk membuat token suara.', headers);
  }
}

/* ==================== Calon pendaftar: form "minta dihubungi via WhatsApp" ==================== */

async function saveLead(req, res, ctx, { schoolId, body, source, headers = {} }) {
  const rate = checkLeadRateLimit(schoolId, clientIp(req));
  if (!rate.allowed) {
    sendError(res, 429, 'SIGI_RATE_LIMITED', 'Terlalu sering mengirim data. Coba lagi beberapa menit lagi.', { ...headers, 'Retry-After': String(rate.retryAfter) });
    return;
  }
  const { lead, message } = validateLead({ ...body, source });
  if (!lead) {
    sendError(res, 400, 'SIGI_BAD_LEAD', message, headers);
    return;
  }
  try {
    const result = await createLead(schoolId, lead);
    ctx.log(`lead ${result.created ? 'baru' : 'diperbarui'} untuk sekolah ${schoolId.slice(0, 8)} (${source})`);
    sendJson(res, result.created ? 201 : 200, { ok: true }, headers);
  } catch (error) {
    ctx.log(`Gagal menyimpan lead: ${ctx.oneLine(error.message)}`);
    sendError(res, 503, 'SIGI_DB_ERROR', 'Data belum bisa disimpan. Coba lagi sebentar, atau hubungi panitia langsung.', headers);
  }
}

// Mode embed (data-key): sekolah dikenali dari Publishable Key, domain dicek lewat allowlist.
async function handleV1Lead(req, res, ctx) {
  const auth = await authenticateV1(req, res, ctx);
  if (!auth) return;
  const body = await readJsonBody(req, res, auth.headers);
  if (!body) return;
  await saveLead(req, res, ctx, { schoolId: auth.school.id, body, source: body.source === 'kiosk' ? 'kiosk' : 'embed', headers: auth.headers });
}

// Mode demo lama (sekolah/*.js + widget.js di server Sigi sendiri): sekolah dikenali dari slug di body.
export async function handleLegacyLead(req, res, ctx) {
  if (!ctx.sameOrigin(req)) {
    sendError(res, 403, 'SIGI_BAD_ORIGIN', 'Permintaan hanya boleh dari halaman Sigi.');
    return;
  }
  const body = await readJsonBody(req, res);
  if (!body) return;
  let school = null;
  try {
    school = await resolveSchoolId(body.schoolId);
  } catch (error) {
    sendError(res, 503, error.code || 'SIGI_DB_ERROR', 'Penyimpanan data belum aktif di server Sigi.');
    return;
  }
  if (!school || school.plan === 'suspended') {
    sendError(res, 404, 'SIGI_NOT_FOUND', 'Sekolah tidak ditemukan.');
    return;
  }
  await saveLead(req, res, ctx, { schoolId: school.id, body, source: body.source === 'kiosk' ? 'kiosk' : 'widget' });
}

/* ==================== Sesi Login Akun Sekolah (/api/auth/*) ==================== */

const USER_COOKIE = 'sigi_session';
const USER_SESSION_SECONDS = 7 * 24 * 60 * 60; // 7 hari

async function signUserToken(userId, expires) {
  const secret = await getSessionSecret();
  const key = createHash('sha256').update(`sigi-user:${secret}`).digest();
  return createHmac('sha256', key).update(`${userId}.${expires}`).digest('hex');
}

async function buildUserCookie(req, userId) {
  const expires = Math.floor(Date.now() / 1000) + USER_SESSION_SECONDS;
  const sig = await signUserToken(userId, expires);
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL === '1';
  return `${USER_COOKIE}=${userId}.${expires}.${sig}; Path=/; Max-Age=${USER_SESSION_SECONDS}; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
}

function clearUserCookie(req) {
  const isHttps = req.headers['x-forwarded-proto'] === 'https' || process.env.VERCEL === '1';
  return `${USER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
}

export async function getSessionUser(req) {
  const cookieHeader = req.headers.cookie || '';
  const part = cookieHeader.split(/;\s*/).find((item) => item.startsWith(`${USER_COOKIE}=`));
  if (!part) return null;
  const match = part.slice(USER_COOKIE.length + 1).match(/^([a-z0-9_-]+)\.(\d{1,12})\.([0-9a-f]{64})$/i);
  if (!match) return null;
  const [, userId, expiresStr, sig] = match;
  if (Number(expiresStr) * 1000 < Date.now()) return null;
  const expected = await signUserToken(userId, Number(expiresStr));
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  return getUserById(userId);
}

async function handleAuthMe(req, res) {
  if (req.method !== 'GET') {
    sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
    return;
  }
  const user = await getSessionUser(req);
  sendJson(res, 200, { authenticated: Boolean(user), user });
}

async function handleAuthRegister(req, res, ctx) {
  if (req.method !== 'POST') {
    sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
    return;
  }
  if (!ctx.sameOrigin(req)) {
    sendError(res, 403, 'SIGI_BAD_ORIGIN', 'Permintaan hanya boleh dari halaman Sigi.');
    return;
  }
  const body = await readJsonBody(req, res);
  if (!body) return;
  try {
    const result = await registerUserWithSchool({
      email: body.email,
      password: body.password,
      adminName: body.name,
      schoolName: body.schoolName,
      origin: ctx.originFor(req.headers.host),
    });
    const cookie = await buildUserCookie(req, result.user.id);
    sendJson(res, 201, { user: result.user, school: result.school }, { 'Set-Cookie': cookie });
  } catch (error) {
    sendError(res, 400, 'SIGI_REGISTER_FAILED', error.message || 'Pendaftaran gagal.');
  }
}

async function handleAuthLogin(req, res, ctx) {
  if (req.method !== 'POST') {
    sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
    return;
  }
  if (!ctx.sameOrigin(req)) {
    sendError(res, 403, 'SIGI_BAD_ORIGIN', 'Permintaan hanya boleh dari halaman Sigi.');
    return;
  }
  const body = await readJsonBody(req, res);
  if (!body) return;
  const user = await authenticateUser(body.email, body.password);
  if (!user) {
    sendError(res, 401, 'SIGI_INVALID_CREDENTIALS', 'Email atau password salah.');
    return;
  }
  const cookie = await buildUserCookie(req, user.id);
  sendJson(res, 200, { user }, { 'Set-Cookie': cookie });
}

async function handleAuthLogout(req, res, ctx) {
  if (req.method !== 'POST') {
    sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
    return;
  }
  if (!ctx.sameOrigin(req)) {
    sendError(res, 403, 'SIGI_BAD_ORIGIN', 'Permintaan hanya boleh dari halaman Sigi.');
    return;
  }
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearUserCookie(req) });
}

/* ==================== Handler /api/dashboard/* ==================== */

async function requireDashboardUser(req, res, ctx, { checkOrigin = false, write = false } = {}) {
  if (checkOrigin && !ctx.sameOrigin(req)) {
    sendError(res, 403, 'SIGI_BAD_ORIGIN', 'Permintaan hanya boleh dari Dashboard Sigi.');
    return null;
  }
  const user = await getSessionUser(req);
  if (!user) {
    sendError(res, 401, 'SIGI_AUTH_REQUIRED', 'Silakan masuk terlebih dahulu melalui halaman login.');
    return null;
  }
  if (write && user.isDemo) {
    sendError(res, 403, 'SIGI_DEMO_READONLY', 'Akun demo hanya bisa melihat. Daftar akun sekolah sendiri untuk mengubah data dan API key.');
    return null;
  }
  return user;
}

async function handleDashboardSchools(req, res, ctx, url) {
  if (req.method === 'GET') {
    const user = await requireDashboardUser(req, res, ctx);
    if (!user) return;
    const schools = await listSchools(user.id);
    const requestedId = url.searchParams.get('id') || schools[0]?.id;
    const active = await getSchool(requestedId, user.id);
    const keys = active ? await listApiKeys(active.id) : [];
    sendJson(res, 200, { user, schools, school: active, apiKeys: keys });
    return;
  }

  if (req.method === 'POST') {
    sendError(res, 403, 'SIGI_ONE_SCHOOL_PER_ACCOUNT', 'Setiap akun hanya mengelola satu sekolah. Untuk membuat sekolah baru, silakan keluar lalu daftar akun baru di halaman login.');
    return;
  }

  sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
}

async function handleDashboardSchoolUpdate(req, res, ctx) {
  if (req.method !== 'PUT' && req.method !== 'PATCH') {
    sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
    return;
  }
  const user = await requireDashboardUser(req, res, ctx, { checkOrigin: true, write: true });
  if (!user) return;
  const body = await readJsonBody(req, res);
  if (!body || typeof body.id !== 'string') {
    if (body) sendError(res, 400, 'SIGI_BAD_BODY', 'ID sekolah wajib diisi.');
    return;
  }
  const owned = await getSchool(body.id, user.id);
  if (!owned) {
    sendError(res, 404, 'SIGI_NOT_FOUND', 'Sekolah tidak ditemukan.');
    return;
  }
  const updated = await updateSchool(body.id, body);
  const schools = await listSchools(user.id);
  sendJson(res, 200, { school: updated, schools });
}

async function handleDashboardKeys(req, res, ctx) {
  if (req.method === 'POST') {
    const user = await requireDashboardUser(req, res, ctx, { checkOrigin: true, write: true });
    if (!user) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const owned = await getSchool(body.schoolId, user.id);
    if (!owned) {
      sendError(res, 404, 'SIGI_NOT_FOUND', 'Sekolah tidak ditemukan.');
      return;
    }
    try {
      const result = await createApiKey(body.schoolId, { kind: body.kind, label: body.label, rotate: body.rotate === true });
      const apiKeys = await listApiKeys(body.schoolId);
      sendJson(res, 201, { ...result, apiKeys });
    } catch (error) {
      if (error.code === 'SIGI_SECRET_KEY_EXISTS') {
        sendError(res, 409, 'SIGI_SECRET_KEY_EXISTS', error.message);
      } else {
        sendError(res, 400, 'SIGI_BAD_BODY', error.message || 'Gagal membuat API key.');
      }
    }
    return;
  }

  if (req.method === 'DELETE') {
    const user = await requireDashboardUser(req, res, ctx, { checkOrigin: true, write: true });
    if (!user) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const owned = await getSchool(body.schoolId, user.id);
    if (!owned) {
      sendError(res, 404, 'SIGI_NOT_FOUND', 'Sekolah tidak ditemukan.');
      return;
    }
    const ok = await revokeApiKey(body.schoolId, body.keyId);
    if (!ok) {
      sendError(res, 404, 'SIGI_NOT_FOUND', 'API key tidak ditemukan atau sudah dicabut.');
      return;
    }
    const apiKeys = await listApiKeys(body.schoolId);
    sendJson(res, 200, { ok: true, apiKeys });
    return;
  }

  sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
}

async function handleDashboardLeads(req, res, ctx, url) {
  if (req.method === 'GET') {
    const user = await requireDashboardUser(req, res, ctx);
    if (!user) return;
    const schoolId = url.searchParams.get('school') || '';
    const owned = cleanUuid(schoolId) ? await getSchool(schoolId, user.id) : null;
    if (!owned) {
      sendError(res, 404, 'SIGI_NOT_FOUND', 'Sekolah tidak ditemukan.');
      return;
    }
    const leads = await listLeads(owned.id);
    sendJson(res, 200, { leads: user.isDemo ? leads.map(maskLead) : leads, masked: user.isDemo === true });
    return;
  }

  if (req.method === 'PATCH') {
    const user = await requireDashboardUser(req, res, ctx, { checkOrigin: true, write: true });
    if (!user) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const owned = cleanUuid(body.schoolId) ? await getSchool(body.schoolId, user.id) : null;
    if (!owned) {
      sendError(res, 404, 'SIGI_NOT_FOUND', 'Sekolah tidak ditemukan.');
      return;
    }
    const lead = await updateLeadStatus(owned.id, body.id, body.status);
    if (!lead) {
      sendError(res, 400, 'SIGI_BAD_BODY', 'Data pendaftar atau statusnya tidak valid.');
      return;
    }
    sendJson(res, 200, { lead });
    return;
  }

  sendError(res, 405, 'SIGI_BAD_METHOD', 'Metode tidak didukung.');
}

/* Pintu masuk utama untuk /api/auth/*, /api/v1/*, dan /api/dashboard/* */
export async function handleV1Api(req, res, ctx) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  if (pathname === '/api/auth/me') {
    await handleAuthMe(req, res);
    return true;
  }
  if (pathname === '/api/auth/register') {
    await handleAuthRegister(req, res, ctx);
    return true;
  }
  if (pathname === '/api/auth/login') {
    await handleAuthLogin(req, res, ctx);
    return true;
  }
  if (pathname === '/api/auth/logout') {
    await handleAuthLogout(req, res, ctx);
    return true;
  }

  if (pathname.startsWith('/api/v1/')) {
    if (req.method === 'OPTIONS') {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '*';
      res.writeHead(204, corsHeaders(origin));
      res.end();
      return true;
    }
    if (req.method === 'GET' && pathname === '/api/v1/widget/config') {
      await handleWidgetConfig(req, res, ctx);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/v1/chat') {
      await handleV1Chat(req, res, ctx);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/v1/speak') {
      await handleV1Speak(req, res, ctx);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/v1/leads') {
      await handleV1Lead(req, res, ctx);
      return true;
    }
    if (req.method === 'POST' && pathname === '/api/v1/voice-token') {
      await handleV1VoiceToken(req, res, ctx);
      return true;
    }
    return false;
  }

  if (pathname === '/api/dashboard/schools') {
    await handleDashboardSchools(req, res, ctx, url);
    return true;
  }
  if (pathname === '/api/dashboard/school') {
    await handleDashboardSchoolUpdate(req, res, ctx);
    return true;
  }
  if (pathname === '/api/dashboard/keys') {
    await handleDashboardKeys(req, res, ctx);
    return true;
  }
  if (pathname === '/api/dashboard/leads') {
    await handleDashboardLeads(req, res, ctx, url);
    return true;
  }

  return false;
}
