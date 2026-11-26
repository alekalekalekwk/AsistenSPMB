/*
 * Pembantu Supabase untuk Sigi (zero-dependency via fetch ke PostgREST/RPC).
 * Seluruh penulisan bersifat fail-open: gangguan database tidak pernah memblokir chat.
 */

const SUPABASE_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS) || 4000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_CHANNELS = new Set(['chat', 'mic', 'call']);
const VALID_SOURCES = new Set(['typed', 'suggestion_chip', 'mic', 'call_voice', 'system_greeting', 'filler']);
const VALID_EVENTS = new Set(['widget_opened', 'suggestion_clicked', 'mic_used', 'call_started', 'call_ended', 'conversation_reset']);

const TOPIC_RULES = [
  { topic: 'biaya', pattern: /\b(biaya|spp|bayar|pembayaran|uang|harga|tarif|gelombang|nominal|rp|cicil|angsuran|daftar ulang)\b/i },
  { topic: 'beasiswa', pattern: /\b(beasiswa|gratis|potongan|diskon|kip|yatim|prestasi|keringanan)\b/i },
  { topic: 'jurusan', pattern: /\b(jurusan|program keahlian|kompetensi|pplg|rpl|tjkt|tkj|dkv|mplb|otkp|pm|bdp|kuliner|tata boga|perhotelan|hotel|cyber)\b/i },
  { topic: 'berkas', pattern: /\b(berkas|syarat|persyaratan|dokumen|rapor|raport|kk|kartu keluarga|akta|ktp|ijazah|skl|golongan darah|buta warna)\b/i },
  { topic: 'jadwal', pattern: /\b(jadwal|kapan|tanggal|jam|buka|tutup|batas|deadline|kuota|penuh|sisa kursi)\b/i },
  { topic: 'ekskul', pattern: /\b(ekskul|ekstrakurikuler|organisasi|osis|pramuka|paskibra|futsal|basket|club|kegiatan|pkl|magang|kerja|bkk)\b/i },
  { topic: 'profil_lokasi', pattern: /\b(alamat|lokasi|dimana|di mana|cabang|akreditasi|kepala sekolah|kurikulum|fasilitas|seragam|asrama|jam belajar|npsn)\b/i },
  { topic: 'kontak', pattern: /\b(kontak|cs|whatsapp|wa|telepon|telp|hubungi|admin|email|instagram|sosmed|nomor)\b/i },
  { topic: 'alur_daftar', pattern: /\b(daftar|pendaftaran|alur|cara daftar|registrasi|link|portal|wawancara|tes|seleksi|spmb|ppdb)\b/i },
];

const UNANSWERED_PATTERNS = [
  /belum\s+(?:punya|memiliki|mendapat|ada)\s+informasi/i,
  /informasi(?:nya)?\s+(?:belum|tidak)\s+(?:tersedia|tercantum|ada)/i,
  /(?:belum|tidak)\s+(?:tersedia|tercantum)\s+(?:di|pada|dalam)/i,
  /(?:belum|tidak)\s+(?:tercantum|tertulis)\b/i,
  /belum\s+(?:diumumkan|ditetapkan|dirilis)/i,
  /di\s+luar\s+(?:informasi|data|cakupan)/i,
  /belum\s+bisa\s+memastikan/i,
];

const CS_REDIRECT_PATTERN = /(?:tanyakan|konfirmasi|hubungi|menghubungi)\s+(?:langsung\s+)?(?:ke\s+)?(?:cs|customer service|panitia)\s*(?:spmb|ppdb)?/i;

export const cleanUuid = (value) => (typeof value === 'string' && UUID_RE.test(value.trim()) ? value.trim().toLowerCase() : null);
const cleanText = (value, max = 120) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export function normalizeSupabaseUrl(raw) {
  const value = cleanText(raw, 300).replace(/\/+$/, '');
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export async function readSupabaseConfig(readKey, isCleanKey) {
  const [rawUrl, rawKey] = await Promise.all([
    readKey('SUPABASE_URL').catch(() => ''),
    readKey('SUPABASE_SERVICE_ROLE_KEY').catch(() => ''),
  ]);
  const url = normalizeSupabaseUrl(rawUrl);
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';
  const validKey = Boolean(key) && isCleanKey(key);
  return {
    configured: Boolean(url && validKey),
    hasUrl: Boolean(url),
    hasKey: Boolean(key),
    validKey,
    url,
    key,
  };
}

// Sensor pola PII (NIK, NISN, KK, rekening, HP, email) sebelum isi percakapan disimpan ke DB.
export function redactPii(input, { isUser = false } = {}) {
  if (typeof input !== 'string' || !input) return { text: '', redacted: false };
  let text = input;
  let redacted = false;
  const replace = (pattern, replacer) => {
    text = text.replace(pattern, (...args) => {
      redacted = true;
      return typeof replacer === 'function' ? replacer(...args) : replacer;
    });
  };

  replace(/(\b(?:nik|nisn|no\.?\s*kk|nomor\s*kk|kartu\s+keluarga|no\.?\s*rek(?:ening)?|rekening|password|kata\s+sandi)\s*[:=#]?\s*)([A-Za-z0-9._-]{5,24})/gi, '$1[disensor]');
  if (isUser) {
    replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email-disensor]');
    replace(/(^|[^\d])((?:\+?62|0)8\d(?:[\s.-]?\d){7,11})(?!\d)/g, '$1[no-hp-disensor]');
    replace(/\b\d{10,20}\b/g, '[nomor-disensor]');
  } else {
    replace(/\b\d{13,20}\b/g, '[nomor-disensor]');
  }
  return { text, redacted };
}

export function classifyTopic(question) {
  if (typeof question !== 'string' || !question.trim()) return 'lainnya';
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(question)) return rule.topic;
  }
  return 'lainnya';
}

export function detectUnanswered(reply, topic) {
  if (typeof reply !== 'string' || !reply.trim()) return false;
  if (UNANSWERED_PATTERNS.some((pattern) => pattern.test(reply))) return true;
  // Pertanyaan khusus minta kontak CS yang dijawab dengan nomor CS bukan kasus "belum terjawab".
  if (topic !== 'kontak' && CS_REDIRECT_PATTERN.test(reply)) return true;
  return false;
}

export function normalizeMeta(raw) {
  const meta = raw && typeof raw === 'object' ? raw : {};
  const channel = VALID_CHANNELS.has(meta.channel) ? meta.channel : 'chat';
  const inputSource = VALID_SOURCES.has(meta.inputSource)
    ? meta.inputSource
    : channel === 'call' ? 'call_voice' : channel === 'mic' ? 'mic' : 'typed';
  return {
    schoolId: cleanText(meta.schoolId, 64) || 'wikrama',
    schoolName: cleanText(meta.schoolName, 120) || 'Sekolah',
    periodLabel: cleanText(meta.periodLabel, 32) || '2027-2028',
    conversationId: cleanUuid(meta.conversationId),
    visitorSessionId: cleanUuid(meta.visitorSessionId),
    channel,
    inputSource,
  };
}

export function supabaseHeaders(key, extra = {}) {
  // Key modern sb_secret_... hanya dikirim di header apikey; Authorization: Bearer hanya untuk JWT legacy.
  const isJwt = typeof key === 'string' && key.split('.').length === 3;
  return {
    apikey: key,
    ...(isJwt ? { Authorization: `Bearer ${key}` } : {}),
    ...extra,
  };
}

export async function callSupabaseRpc(config, fnName, payload) {
  const response = await fetch(`${config.url}/rest/v1/rpc/${fnName}`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    headers: supabaseHeaders(config.key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // Biarkan null agar pesan HTML/teks tetap tertangani oleh caller.
  }
  if (!response.ok) {
    const detail = data?.message || data?.hint || data?.error || text.slice(0, 150) || `HTTP ${response.status}`;
    throw new Error(`${response.status}: ${detail}`);
  }
  return data;
}

export async function logChatTurn(config, log, oneLine, entry) {
  if (!config.configured) return;
  const meta = normalizeMeta(entry.meta);
  const userSafe = entry.userContent ? redactPii(entry.userContent, { isUser: true }) : { text: null, redacted: false };
  const assistantSafe = entry.assistantContent ? redactPii(entry.assistantContent, { isUser: false }) : { text: null, redacted: false };
  const topic = userSafe.text ? classifyTopic(userSafe.text) : 'lainnya';
  const isUnanswered = assistantSafe.text ? detectUnanswered(assistantSafe.text, topic) : false;

  try {
    await callSupabaseRpc(config, 'record_chat_turn', {
      p_school_id: meta.schoolId,
      p_school_name: meta.schoolName,
      p_period_label: meta.periodLabel,
      p_conversation_id: meta.conversationId,
      p_visitor_session_id: meta.visitorSessionId,
      p_channel: meta.channel,
      p_input_source: meta.inputSource,
      p_user_content: userSafe.text,
      p_user_redacted: userSafe.redacted,
      p_assistant_content: assistantSafe.text,
      p_assistant_redacted: assistantSafe.redacted,
      p_topic: topic,
      p_is_unanswered: isUnanswered,
      p_model: cleanText(entry.model, 120) || 'unknown',
      p_netra_request_id: cleanText(entry.requestId, 120) || null,
      p_prompt_tokens: Number.isInteger(entry.promptTokens) ? entry.promptTokens : null,
      p_completion_tokens: Number.isInteger(entry.completionTokens) ? entry.completionTokens : null,
      p_total_tokens: Number.isInteger(entry.totalTokens) ? entry.totalTokens : null,
      p_latency_ms: Math.max(0, Math.round(Number(entry.latencyMs) || 0)),
      p_http_status: Number.isInteger(entry.httpStatus) ? entry.httpStatus : 0,
      p_error_code: cleanText(entry.errorCode, 64) || null,
    });
  } catch (error) {
    log(`Gagal mencatat chat ke Supabase: ${oneLine(error.message, config.key)}`);
  }
}

export async function logWidgetEvent(config, log, oneLine, rawBody) {
  if (!config.configured) return { skipped: true };
  const eventName = cleanText(rawBody?.eventName, 40);
  if (!VALID_EVENTS.has(eventName)) return { invalid: true };
  const meta = normalizeMeta(rawBody);
  const metadata = rawBody?.metadata && typeof rawBody.metadata === 'object' && !Array.isArray(rawBody.metadata)
    ? rawBody.metadata
    : {};
  const safeMeta = {};
  if (typeof metadata.label === 'string') safeMeta.label = redactPii(metadata.label.slice(0, 160), { isUser: true }).text;
  if (Number.isInteger(metadata.duration_seconds) && metadata.duration_seconds >= 0) safeMeta.duration_seconds = metadata.duration_seconds;

  try {
    await callSupabaseRpc(config, 'record_widget_event', {
      p_school_id: meta.schoolId,
      p_school_name: meta.schoolName,
      p_period_label: meta.periodLabel,
      p_conversation_id: meta.conversationId,
      p_visitor_session_id: meta.visitorSessionId,
      p_event_name: eventName,
      p_channel: VALID_CHANNELS.has(rawBody?.channel) ? rawBody.channel : null,
      p_metadata: safeMeta,
    });
    return { ok: true };
  } catch (error) {
    log(`Gagal mencatat event ke Supabase: ${oneLine(error.message, config.key)}`);
    return { ok: false };
  }
}

export async function checkSupabase(readKey, isCleanKey, keyId, oneLine) {
  const config = await readSupabaseConfig(readKey, isCleanKey);
  if (!config.hasUrl && !config.hasKey) return 'SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY belum diisi (opsional untuk mode demo).';
  if (!config.hasUrl) return 'SUPABASE_URL di .env belum diisi atau format URL tidak sah.';
  if (!config.hasKey) return 'SUPABASE_SERVICE_ROLE_KEY di .env masih kosong.';
  if (!config.validKey) return 'SUPABASE_SERVICE_ROLE_KEY di .env berisi spasi atau karakter yang tidak wajar.';
  try {
    const response = await fetch(`${config.url}/rest/v1/schools?select=id&limit=1`, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: supabaseHeaders(config.key),
    });
    if (response.ok) return `Supabase terhubung (${new URL(config.url).host}, key ${keyId(config.key)}). Tabel schools siap.`;
    const text = await response.text().catch(() => '');
    return `Supabase menjawab ${response.status} (${keyId(config.key)}): ${oneLine(text, config.key) || 'periksa schema.sql'}`;
  } catch (error) {
    return `Tidak bisa terhubung ke Supabase: ${oneLine(error.cause?.code || error.message, config.key)}`;
  }
}
