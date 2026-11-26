/*
 * Storage Adapter Sigi — terhubung langsung ke Supabase (Auth + PostgreSQL PostgREST + RPC).
 *
 * Menggunakan skema terpadu di supabase/schema.sql:
 * - auth.users (Supabase Auth)
 * - public.schools, public.school_members, public.school_pages, public.school_documents, public.api_keys
 * - RPC: create_school_workspace, resolve_api_key, increment_school_usage
 *
 * Zero-dependency (murni fetch Node.js 20+), memakai SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callSupabaseRpc, cleanUuid, readSupabaseConfig, supabaseHeaders } from './supabase.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(ROOT);
const DB_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS) || 10_000;

export const DEFAULT_TRIAL_QUOTA = 50;
export const MAX_CONTEXT_CHARS = 60_000;
export const DEMO_ACCOUNT = { email: 'admin@wikrama.demo', password: 'wikrama-demo-123' };
const DEMO_PUBLISHABLE_KEY = 'sg_pk_demo_wikrama_2027';

let keyReader = async (name) => (process.env[name] || '').trim();
let keyValidator = (key) => /^[\x21-\x7e]+$/.test(key);

export function configureStore({ readKey, isCleanKey } = {}) {
  if (typeof readKey === 'function') keyReader = readKey;
  if (typeof isCleanKey === 'function') keyValidator = isCleanKey;
}

export function hashApiKey(rawKey) {
  return createHash('sha256').update(String(rawKey)).digest('hex');
}

export function generateRawKey(kind) {
  if (kind === 'publishable') return `sg_pk_live_${randomBytes(16).toString('hex')}`;
  if (kind === 'secret') return `sg_sk_live_${randomBytes(24).toString('hex')}`;
  throw new Error('Jenis key tidak valid.');
}

export function normalizeOrigin(input) {
  if (typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (trimmed === '*') return '*';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin.toLowerCase();
  } catch {
    return '';
  }
}

function slugify(name) {
  const base = String(name || 'sekolah')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'sekolah';
  return `${base}-${randomBytes(2).toString('hex')}`;
}

async function requireSupabase() {
  const cfg = await readSupabaseConfig(keyReader, keyValidator);
  if (!cfg.configured) {
    const err = new Error('SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY belum diisi di .env atau Environment Variables.');
    err.code = 'SIGI_SUPABASE_UNCONFIGURED';
    throw err;
  }
  return cfg;
}

export async function isSupabaseReady() {
  const cfg = await readSupabaseConfig(keyReader, keyValidator);
  return cfg.configured;
}

async function rest(cfg, path, { method = 'GET', body, prefer } = {}) {
  const headers = supabaseHeaders(cfg.key, {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(prefer ? { Prefer: prefer } : {}),
  });
  const response = await fetch(`${cfg.url}/rest/v1${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(DB_TIMEOUT_MS),
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON
  }
  if (!response.ok) {
    const detail = data?.message || data?.hint || data?.error || text.slice(0, 200) || `HTTP ${response.status}`;
    const err = new Error(detail);
    err.status = response.status;
    err.pgCode = data?.code;
    throw err;
  }
  return data;
}

async function authFetch(cfg, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${cfg.url}/auth/v1${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(DB_TIMEOUT_MS),
    headers: supabaseHeaders(cfg.key, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON
  }
  return { ok: response.ok, status: response.status, data, text };
}

function mapSchoolRow(row, pages = [], documents = []) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan || 'trial',
    chatQuota: Number(row.chat_quota ?? DEFAULT_TRIAL_QUOTA),
    chatUsed: Number(row.chat_used ?? 0),
    theme: {
      primary: '#0f766e',
      onPrimary: '#ffffff',
      accent: '#bef264',
      onAccent: '#0b1f1d',
      ...(row.theme && typeof row.theme === 'object' ? row.theme : {}),
    },
    greeting: row.greeting || `Halo! Aku Asisten SPMB ${row.name}. Ada yang bisa dibantu?`,
    suggestions: Array.isArray(row.suggestions) ? row.suggestions : [],
    voiceEnabled: Boolean(row.voice_enabled),
    voiceId: row.voice_id || 'flux-fitri-id',
    voiceExpressivity: Number.isInteger(row.voice_expressivity) ? row.voice_expressivity : 1,
    allowedOrigins: Array.isArray(row.allowed_origins) ? row.allowed_origins : [],
    activePeriodLabel: row.active_period_label || '2027-2028',
    pages: pages.map((p) => ({
      id: p.id,
      title: p.title || '',
      body: p.body || '',
      sortOrder: p.sort_order ?? 0,
      updatedAt: p.updated_at ? Date.parse(p.updated_at) : null,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      name: d.file_name || 'dokumen.pdf',
      size: Number(d.extracted_text?.length || 0),
      pages: Number(d.page_count || 0),
      text: d.extracted_text || '',
      addedAt: d.created_at ? Date.parse(d.created_at) : null,
    })),
    createdAt: row.created_at ? Date.parse(row.created_at) : null,
    updatedAt: row.created_at ? Date.parse(row.created_at) : null,
  };
}

function mapKeyRow(row) {
  return {
    id: row.id,
    schoolId: row.school_id,
    kind: row.kind,
    label: row.label || '',
    keyPrefix: row.key_prefix,
    keyValue: row.kind === 'publishable' ? row.key_value : null,
    createdAt: row.created_at ? Date.parse(row.created_at) : null,
    lastUsedAt: row.last_used_at ? Date.parse(row.last_used_at) : null,
    revokedAt: row.revoked_at ? Date.parse(row.revoked_at) : null,
  };
}

function mapAuthUser(u) {
  if (!u || !u.id) return null;
  return {
    id: u.id,
    email: u.email || '',
    name: u.user_metadata?.name || u.email || 'Admin Sekolah',
    createdAt: u.created_at ? Date.parse(u.created_at) : null,
    // Akun demo dipakai bersama (password-nya terbuka di halaman login), jadi hanya boleh melihat.
    isDemo: (u.email || '').toLowerCase() === DEMO_ACCOUNT.email,
  };
}

async function readWikramaContextFallback() {
  try {
    return (await readFile(join(PROJECT_ROOT, 'konteks-wikrama.txt'), 'utf8')).trim();
  } catch {
    return '';
  }
}

/* Memastikan akun demo SMK Wikrama & publishable key demo tersedia di Supabase pada klik pertama. */
async function ensureDemoWikramaSeeded(cfg) {
  // 1. Cari atau buat user demo di Supabase Auth
  let demoUser = null;
  const listRes = await authFetch(cfg, '/admin/users?page=1&per_page=100');
  if (listRes.ok && Array.isArray(listRes.data?.users)) {
    demoUser = listRes.data.users.find((u) => (u.email || '').toLowerCase() === DEMO_ACCOUNT.email);
  }
  if (!demoUser) {
    const createRes = await authFetch(cfg, '/admin/users', {
      method: 'POST',
      body: {
        email: DEMO_ACCOUNT.email,
        password: DEMO_ACCOUNT.password,
        email_confirm: true,
        user_metadata: { name: 'Admin SMK Wikrama Bogor' },
      },
    });
    if (createRes.ok && createRes.data?.id) demoUser = createRes.data;
  }
  if (!demoUser?.id) return null;

  // 2. Pastikan sekolah slug 'wikrama' ada
  const schools = await rest(cfg, '/schools?slug=eq.wikrama&limit=1');
  const wikrama = schools?.[0];
  if (!wikrama) return mapAuthUser(demoUser);

  // 3. Tautkan user demo sebagai owner di school_members
  await rest(cfg, '/school_members?on_conflict=school_id,user_id', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body: { school_id: wikrama.id, user_id: demoUser.id, role: 'owner' },
  }).catch(() => {});

  // 4. Pastikan allowed_origins mencakup localhost:8123 untuk pengujian lokal
  const existingOrigins = Array.isArray(wikrama.allowed_origins) ? wikrama.allowed_origins : [];
  if (existingOrigins.length === 0) {
    await rest(cfg, `/schools?id=eq.${wikrama.id}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { allowed_origins: ['http://127.0.0.1:8123', 'http://localhost:8123'] },
    }).catch(() => {});
  }

  // 5. Jika school_pages masih kosong, isi dari konteks-wikrama.txt
  const existingPages = await rest(cfg, `/school_pages?school_id=eq.${wikrama.id}&select=id&limit=1`);
  if (!existingPages || existingPages.length === 0) {
    const bodyText = await readWikramaContextFallback();
    if (bodyText) {
      await rest(cfg, '/school_pages', {
        method: 'POST',
        prefer: 'return=minimal',
        body: {
          school_id: wikrama.id,
          title: 'Info SPMB & Profil SMK Wikrama Bogor',
          body: bodyText,
          sort_order: 1,
        },
      }).catch(() => {});
    }
  }

  // 6. Jika belum punya publishable key aktif, buat key demo bawaan
  const existingKeys = await rest(cfg, `/api_keys?school_id=eq.${wikrama.id}&kind=eq.publishable&revoked_at=is.null&select=id&limit=1`);
  if (!existingKeys || existingKeys.length === 0) {
    await rest(cfg, '/api_keys', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        school_id: wikrama.id,
        kind: 'publishable',
        label: 'Widget Website (Demo)',
        key_prefix: DEMO_PUBLISHABLE_KEY.slice(0, 14),
        key_value: DEMO_PUBLISHABLE_KEY,
        key_hash: hashApiKey(DEMO_PUBLISHABLE_KEY),
      },
    }).catch(() => {});
  }

  return mapAuthUser(demoUser);
}

/* ==================== Autentikasi Akun Sekolah (Supabase Auth) ==================== */

export async function getSessionSecret() {
  const explicit = (process.env.SIGI_SESSION_SECRET || process.env.SIGI_PASSWORD || '').trim();
  if (explicit.length >= 12) return explicit;
  const cfg = await readSupabaseConfig(keyReader, keyValidator);
  if (cfg.key) return createHash('sha256').update(`sigi-cookie-secret:${cfg.key}`).digest('hex');
  return 'sigi-local-dev-fallback-secret';
}

export async function getUserById(userId) {
  if (!cleanUuid(userId)) return null;
  const cfg = await requireSupabase();
  const res = await authFetch(cfg, `/admin/users/${encodeURIComponent(userId)}`);
  if (!res.ok) return null;
  return mapAuthUser(res.data);
}

export async function authenticateUser(email, password) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || typeof password !== 'string' || !password) return null;
  const cfg = await requireSupabase();

  // Login langsung ke Supabase Auth GoTrue
  let res = await authFetch(cfg, '/token?grant_type=password', {
    method: 'POST',
    body: { email: cleanEmail, password },
  });

  // Jika akun demo belum pernah dibuat di Supabase, seed otomatis sekali lalu login ulang.
  if (!res.ok && cleanEmail === DEMO_ACCOUNT.email && password === DEMO_ACCOUNT.password) {
    await ensureDemoWikramaSeeded(cfg);
    res = await authFetch(cfg, '/token?grant_type=password', {
      method: 'POST',
      body: { email: cleanEmail, password },
    });
  }

  if (!res.ok || !res.data?.user) return null;
  return mapAuthUser(res.data.user);
}

export async function registerUserWithSchool({ email, password, adminName, schoolName, origin = '' }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error('Format email tidak valid.');
  }
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password minimal 8 karakter.');
  }
  const cleanSchool = String(schoolName || '').trim().slice(0, 120);
  if (!cleanSchool) {
    throw new Error('Nama sekolah wajib diisi.');
  }

  const cfg = await requireSupabase();

  const createRes = await authFetch(cfg, '/admin/users', {
    method: 'POST',
    body: {
      email: cleanEmail,
      password,
      email_confirm: true,
      user_metadata: { name: String(adminName || `Admin ${cleanSchool}`).trim().slice(0, 100) },
    },
  });

  if (!createRes.ok || !createRes.data?.id) {
    const rawMsg = createRes.data?.msg || createRes.data?.message || createRes.data?.error_description || '';
    if (/already|registered|exists/i.test(rawMsg)) {
      throw new Error('Email ini sudah terdaftar. Silakan masuk menggunakan akun tersebut.');
    }
    throw new Error(rawMsg || 'Gagal mendaftarkan akun di Supabase Auth.');
  }

  const user = mapAuthUser(createRes.data);
  try {
    const created = await createSchool({
      name: cleanSchool,
      origin,
      ownerUserId: user.id,
    });
    return { user, school: created.school, publishableKey: created.publishableKey };
  } catch (error) {
    // Rollback user jika pembuatan workspace gagal agar email tidak menggantung.
    await authFetch(cfg, `/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' }).catch(() => {});
    throw error;
  }
}

/* ==================== Manajemen Sekolah & Konteks (Supabase DB) ==================== */

export async function listSchools(ownerUserId) {
  const cfg = await requireSupabase();
  if (!cleanUuid(ownerUserId)) return [];
  const rows = await rest(
    cfg,
    `/school_members?user_id=eq.${encodeURIComponent(ownerUserId)}&select=role,schools(id,name,slug,plan,chat_quota,chat_used,created_at)&order=created_at.asc`,
  );
  return (rows || [])
    .map((item) => item.schools)
    .filter(Boolean)
    .map((s) => ({
      id: s.id,
      name: s.name,
      slug: s.slug,
      plan: s.plan,
      chatQuota: Number(s.chat_quota ?? DEFAULT_TRIAL_QUOTA),
      chatUsed: Number(s.chat_used ?? 0),
      updatedAt: s.created_at ? Date.parse(s.created_at) : null,
    }));
}

async function assertSchoolMember(cfg, schoolId, ownerUserId) {
  if (!cleanUuid(schoolId)) return false;
  if (!ownerUserId) return true;
  if (!cleanUuid(ownerUserId)) return false;
  const rows = await rest(
    cfg,
    `/school_members?school_id=eq.${encodeURIComponent(schoolId)}&user_id=eq.${encodeURIComponent(ownerUserId)}&select=role&limit=1`,
  );
  return Array.isArray(rows) && rows.length > 0;
}

export async function getSchool(schoolId, ownerUserId) {
  const cfg = await requireSupabase();
  let targetId = cleanUuid(schoolId);

  if (!targetId) {
    const list = await listSchools(ownerUserId);
    targetId = list[0]?.id || null;
  } else if (ownerUserId) {
    const allowed = await assertSchoolMember(cfg, targetId, ownerUserId);
    if (!allowed) return null;
  }

  if (!targetId) return null;

  const [schoolRows, pages, documents] = await Promise.all([
    rest(cfg, `/schools?id=eq.${encodeURIComponent(targetId)}&limit=1`),
    rest(cfg, `/school_pages?school_id=eq.${encodeURIComponent(targetId)}&order=sort_order.asc,updated_at.asc`),
    rest(cfg, `/school_documents?school_id=eq.${encodeURIComponent(targetId)}&order=created_at.desc`),
  ]);

  const row = schoolRows?.[0];
  if (!row) return null;
  return mapSchoolRow(row, pages || [], documents || []);
}

export async function createSchool({ name, origin = '', ownerUserId } = {}) {
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) throw new Error('Nama sekolah wajib diisi.');
  if (!cleanUuid(ownerUserId)) throw new Error('User pemilik sekolah tidak valid.');

  const cfg = await requireSupabase();
  const slug = slugify(cleanName);

  // Gunakan RPC resmi dari supabase/schema.sql: membuat schools + school_members + 6 halaman template sekaligus!
  const rpcResult = await callSupabaseRpc(cfg, 'create_school_workspace', {
    p_user_id: ownerUserId,
    p_name: cleanName,
    p_slug: slug,
  });
  const schoolId = rpcResult?.school_id;
  if (!schoolId) throw new Error('Supabase gagal membuat workspace sekolah.');

  const origins = new Set(['http://127.0.0.1:8123', 'http://localhost:8123']);
  const normalized = normalizeOrigin(origin);
  if (normalized) origins.add(normalized);

  await rest(cfg, `/schools?id=eq.${encodeURIComponent(schoolId)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: {
      greeting: `Halo! Aku Asisten SPMB ${cleanName}. Ada yang bisa dibantu seputar pendaftaran atau jurusan?`,
      suggestions: [
        'Bagaimana cara daftarnya?',
        'Ada jurusan atau program apa saja?',
        'Berkas apa yang perlu disiapkan?',
      ],
      allowed_origins: [...origins],
    },
  });

  const { keyRecord } = await createApiKey(schoolId, { kind: 'publishable', label: 'Widget Website' });
  const school = await getSchool(schoolId, ownerUserId);
  return { school, publishableKey: keyRecord };
}

export async function updateSchool(schoolId, patch = {}) {
  if (!cleanUuid(schoolId)) return null;
  const cfg = await requireSupabase();

  const existing = await getSchool(schoolId);
  if (!existing) return null;

  const schoolPatch = {};
  if (typeof patch.name === 'string' && patch.name.trim()) {
    schoolPatch.name = patch.name.trim().slice(0, 120);
  }
  if (patch.theme && typeof patch.theme === 'object') {
    const hex = (v, fallback) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);
    schoolPatch.theme = {
      primary: hex(patch.theme.primary, existing.theme.primary),
      onPrimary: hex(patch.theme.onPrimary, existing.theme.onPrimary),
      accent: hex(patch.theme.accent, existing.theme.accent),
      onAccent: hex(patch.theme.onAccent, existing.theme.onAccent),
    };
  }
  if (typeof patch.greeting === 'string') {
    schoolPatch.greeting = patch.greeting.trim().slice(0, 600);
  }
  if (Array.isArray(patch.suggestions)) {
    schoolPatch.suggestions = patch.suggestions.slice(0, 6).map((item) => String(item || '').slice(0, 160));
  }
  if (typeof patch.voiceEnabled === 'boolean') {
    schoolPatch.voice_enabled = patch.voiceEnabled;
  }
  if (typeof patch.voiceId === 'string' && /^flux-[a-z]+-id$/.test(patch.voiceId)) {
    schoolPatch.voice_id = patch.voiceId;
  }
  if (Number.isInteger(patch.voiceExpressivity) && Math.abs(patch.voiceExpressivity) <= 2) {
    schoolPatch.voice_expressivity = patch.voiceExpressivity;
  }
  if (Array.isArray(patch.allowedOrigins)) {
    schoolPatch.allowed_origins = [...new Set(patch.allowedOrigins.map(normalizeOrigin).filter(Boolean))].slice(0, 20);
  }

  if (Object.keys(schoolPatch).length > 0) {
    await rest(cfg, `/schools?id=eq.${encodeURIComponent(schoolId)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: schoolPatch,
    });
  }

  // Sinkronkan school_pages (update existing, insert new, delete removed)
  if (Array.isArray(patch.pages)) {
    const existingIds = new Set(existing.pages.map((p) => p.id));
    const keptIds = new Set();
    const toInsert = [];

    for (let i = 0; i < Math.min(patch.pages.length, 40); i++) {
      const p = patch.pages[i];
      const title = String(p.title || '').slice(0, 160);
      const body = String(p.body || '').slice(0, MAX_CONTEXT_CHARS);
      const sortOrder = i + 1;
      const validId = cleanUuid(p.id);

      if (validId && existingIds.has(validId)) {
        keptIds.add(validId);
        const prev = existing.pages.find((x) => x.id === validId);
        if (!prev || prev.title !== title || prev.body !== body || prev.sortOrder !== sortOrder) {
          await rest(cfg, `/school_pages?id=eq.${encodeURIComponent(validId)}&school_id=eq.${encodeURIComponent(schoolId)}`, {
            method: 'PATCH',
            prefer: 'return=minimal',
            body: { title, body, sort_order: sortOrder },
          });
        }
      } else {
        toInsert.push({ school_id: schoolId, title, body, sort_order: sortOrder });
      }
    }

    const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
    if (toDelete.length > 0) {
      await rest(
        cfg,
        `/school_pages?school_id=eq.${encodeURIComponent(schoolId)}&id=in.(${toDelete.join(',')})`,
        { method: 'DELETE', prefer: 'return=minimal' },
      );
    }
    if (toInsert.length > 0) {
      await rest(cfg, '/school_pages', {
        method: 'POST',
        prefer: 'return=minimal',
        body: toInsert,
      });
    }
  }

  // Sinkronkan school_documents (insert baru, hapus yang dihapus)
  if (Array.isArray(patch.documents)) {
    const existingIds = new Set(existing.documents.map((d) => d.id));
    const keptIds = new Set();
    const toInsert = [];

    for (const doc of patch.documents.slice(0, 20)) {
      const validId = cleanUuid(doc.id);
      if (validId && existingIds.has(validId)) {
        keptIds.add(validId);
      } else {
        toInsert.push({
          school_id: schoolId,
          file_name: String(doc.name || 'dokumen.pdf').slice(0, 160),
          page_count: Math.max(0, Number(doc.pages) || 0),
          extracted_text: String(doc.text || '').slice(0, MAX_CONTEXT_CHARS),
        });
      }
    }

    const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
    if (toDelete.length > 0) {
      await rest(
        cfg,
        `/school_documents?school_id=eq.${encodeURIComponent(schoolId)}&id=in.(${toDelete.join(',')})`,
        { method: 'DELETE', prefer: 'return=minimal' },
      );
    }
    if (toInsert.length > 0) {
      await rest(cfg, '/school_documents', {
        method: 'POST',
        prefer: 'return=minimal',
        body: toInsert,
      });
    }
  }

  return getSchool(schoolId);
}

/* ==================== Manajemen API Key (Supabase public.api_keys) ==================== */

export async function listApiKeys(schoolId) {
  if (!cleanUuid(schoolId)) return [];
  const cfg = await requireSupabase();
  const rows = await rest(
    cfg,
    `/api_keys?school_id=eq.${encodeURIComponent(schoolId)}&select=id,school_id,kind,label,key_prefix,key_value,last_used_at,revoked_at,created_at&order=created_at.desc`,
  );
  return (rows || []).map(mapKeyRow);
}

export async function createApiKey(schoolId, { kind, label, rotate = false } = {}) {
  if (!cleanUuid(schoolId)) return null;
  if (kind !== 'publishable' && kind !== 'secret') throw new Error('Jenis key harus publishable atau secret.');
  const cfg = await requireSupabase();

  const nowIso = new Date().toISOString();

  // Batasi maksimal 1 Secret Key aktif per sekolah agar tidak bisa diternak.
  if (kind === 'secret') {
    const activeSecrets = await rest(
      cfg,
      `/api_keys?school_id=eq.${encodeURIComponent(schoolId)}&kind=eq.secret&revoked_at=is.null&select=id`,
    );
    if (Array.isArray(activeSecrets) && activeSecrets.length > 0 && !rotate) {
      const err = new Error('Setiap sekolah hanya boleh memiliki 1 Secret Key aktif. Cabut atau putar ulang key yang ada terlebih dahulu.');
      err.code = 'SIGI_SECRET_KEY_EXISTS';
      throw err;
    }
    if (Array.isArray(activeSecrets) && activeSecrets.length > 0) {
      await rest(
        cfg,
        `/api_keys?school_id=eq.${encodeURIComponent(schoolId)}&kind=eq.secret&revoked_at=is.null`,
        { method: 'PATCH', prefer: 'return=minimal', body: { revoked_at: nowIso } },
      );
    }
  }

  // Untuk Publishable Key, rotasi mencabut key publishable aktif sebelumnya.
  if (kind === 'publishable') {
    await rest(
      cfg,
      `/api_keys?school_id=eq.${encodeURIComponent(schoolId)}&kind=eq.publishable&revoked_at=is.null`,
      { method: 'PATCH', prefer: 'return=minimal', body: { revoked_at: nowIso } },
    );
  }

  const plainKey = generateRawKey(kind);
  const inserted = await rest(cfg, '/api_keys?select=id,school_id,kind,label,key_prefix,key_value,last_used_at,revoked_at,created_at', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      school_id: schoolId,
      kind,
      label: String(label || (kind === 'publishable' ? 'Widget Website' : 'Backend REST API')).trim().slice(0, 80),
      key_prefix: plainKey.slice(0, 14),
      key_value: kind === 'publishable' ? plainKey : null,
      key_hash: hashApiKey(plainKey),
    },
  });

  const record = inserted?.[0];
  if (!record) throw new Error('Gagal menyimpan API key di Supabase.');
  return { keyRecord: mapKeyRow(record), plainKey };
}

export async function revokeApiKey(schoolId, keyId) {
  if (!cleanUuid(schoolId) || !cleanUuid(keyId)) return false;
  const cfg = await requireSupabase();
  const updated = await rest(
    cfg,
    `/api_keys?id=eq.${encodeURIComponent(keyId)}&school_id=eq.${encodeURIComponent(schoolId)}&revoked_at=is.null&select=id`,
    { method: 'PATCH', prefer: 'return=representation', body: { revoked_at: new Date().toISOString() } },
  );
  return Array.isArray(updated) && updated.length > 0;
}

export async function findActiveKey(rawKey, { includeContext = false } = {}) {
  if (typeof rawKey !== 'string' || !rawKey.trim()) return null;
  const cfg = await requireSupabase();
  const trimmed = rawKey.trim();

  let resolved = await callSupabaseRpc(cfg, 'resolve_api_key', { p_key_hash: hashApiKey(trimmed) });

  // Jika key demo bawaan belum sempat di-seed, seed sekali secara otomatis lalu cek ulang.
  if (!resolved?.found && trimmed === DEMO_PUBLISHABLE_KEY) {
    await ensureDemoWikramaSeeded(cfg);
    resolved = await callSupabaseRpc(cfg, 'resolve_api_key', { p_key_hash: hashApiKey(trimmed) });
  }

  if (!resolved?.found || resolved.revoked || !resolved.school?.id) return null;

  let pages = [];
  let documents = [];
  if (includeContext) {
    [pages, documents] = await Promise.all([
      rest(cfg, `/school_pages?school_id=eq.${encodeURIComponent(resolved.school.id)}&order=sort_order.asc,updated_at.asc`),
      rest(cfg, `/school_documents?school_id=eq.${encodeURIComponent(resolved.school.id)}&order=created_at.desc`),
    ]);
  }

  return {
    apiKey: {
      id: resolved.api_key_id,
      schoolId: resolved.school.id,
      kind: resolved.kind,
    },
    school: mapSchoolRow(resolved.school, pages || [], documents || []),
  };
}

export async function consumeChatUsage(schoolId, apiKeyId) {
  const cfg = await requireSupabase();
  return callSupabaseRpc(cfg, 'increment_school_usage', {
    p_school_id: schoolId,
    p_api_key_id: apiKeyId || null,
  });
}

export async function touchApiKeyUsage(apiKeyId) {
  if (!cleanUuid(apiKeyId)) return;
  const cfg = await requireSupabase();
  await rest(cfg, `/api_keys?id=eq.${encodeURIComponent(apiKeyId)}`, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { last_used_at: new Date().toISOString() },
  }).catch(() => {});
}

/* ==================== Calon pendaftar (Supabase public.leads) ==================== */

export const LEAD_STATUSES = ['baru', 'dihubungi', 'mendaftar', 'batal'];
const LEAD_SOURCES = ['widget', 'embed', 'kiosk'];
const LEAD_DEDUPE_MS = 24 * 60 * 60 * 1000;

// Nomor WA Indonesia disimpan seragam sebagai 62xxxxxxxxxx. Menerima 08..., +62..., 62..., atau 8...
export function normalizeWhatsapp(input) {
  const digits = String(input ?? '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '').replace(/^\+/, '');
  let local = digits;
  if (local.startsWith('62')) local = local.slice(2);
  else if (local.startsWith('0')) local = local.slice(1);
  if (!/^8\d{7,12}$/.test(local)) return '';
  return `62${local}`;
}

const cleanLine = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Mengembalikan { lead } kalau valid, atau { message } untuk ditampilkan ke pengunjung.
export function validateLead(raw = {}) {
  const name = cleanLine(raw.name, 80);
  if (name.length < 2) return { message: 'Nama minimal 2 huruf.' };
  const whatsapp = normalizeWhatsapp(raw.whatsapp);
  if (!whatsapp) return { message: 'Nomor WhatsApp belum benar. Contoh: 0812 3456 7890.' };
  if (raw.consent !== true) return { message: 'Centang persetujuan dulu supaya panitia boleh menghubungi.' };
  const interest = cleanLine(raw.interest, 80) || null;
  const source = LEAD_SOURCES.includes(raw.source) ? raw.source : 'widget';
  return {
    lead: {
      name,
      whatsapp,
      interest,
      source,
      conversationId: cleanUuid(raw.conversationId),
      visitorSessionId: cleanUuid(raw.visitorSessionId),
    },
  };
}

// Mode demo lama memakai slug (misalnya "wikrama"); mode embed sudah memegang UUID sekolah.
export async function resolveSchoolId(ref) {
  const uuid = cleanUuid(ref);
  const cfg = await requireSupabase();
  const filter = uuid ? `id=eq.${encodeURIComponent(uuid)}` : `slug=eq.${encodeURIComponent(String(ref || '').trim().toLowerCase())}`;
  const rows = await rest(cfg, `/schools?${filter}&select=id,plan&limit=1`);
  return rows?.[0] || null;
}

// Nomor yang sama dalam 24 jam tidak dibuat dua kali: datanya diperbarui saja.
export async function createLead(schoolId, lead) {
  if (!cleanUuid(schoolId)) throw new Error('ID sekolah tidak valid.');
  const cfg = await requireSupabase();
  const since = new Date(Date.now() - LEAD_DEDUPE_MS).toISOString();
  const existing = await rest(
    cfg,
    `/leads?school_id=eq.${encodeURIComponent(schoolId)}&whatsapp=eq.${encodeURIComponent(lead.whatsapp)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`,
  );
  if (existing?.[0]?.id) {
    await rest(cfg, `/leads?id=eq.${encodeURIComponent(existing[0].id)}`, {
      method: 'PATCH',
      prefer: 'return=minimal',
      body: { name: lead.name, interest: lead.interest, updated_at: new Date().toISOString() },
    });
    return { id: existing[0].id, created: false };
  }
  const inserted = await rest(cfg, '/leads?select=id', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      school_id: schoolId,
      name: lead.name,
      whatsapp: lead.whatsapp,
      interest: lead.interest,
      source: lead.source,
      conversation_id: lead.conversationId,
      visitor_session_id: lead.visitorSessionId,
    },
  });
  return { id: inserted?.[0]?.id || null, created: true };
}

function mapLeadRow(row) {
  return {
    id: row.id,
    name: row.name,
    whatsapp: row.whatsapp,
    interest: row.interest || '',
    status: row.status,
    source: row.source,
    createdAt: row.created_at ? Date.parse(row.created_at) : null,
    updatedAt: row.updated_at ? Date.parse(row.updated_at) : null,
  };
}

export async function listLeads(schoolId, { limit = 1000 } = {}) {
  if (!cleanUuid(schoolId)) return [];
  const cfg = await requireSupabase();
  const rows = await rest(
    cfg,
    `/leads?school_id=eq.${encodeURIComponent(schoolId)}&select=id,name,whatsapp,interest,status,source,created_at,updated_at&order=created_at.desc&limit=${Math.min(Math.max(1, limit), 5000)}`,
  );
  return (rows || []).map(mapLeadRow);
}

export async function updateLeadStatus(schoolId, leadId, status) {
  if (!cleanUuid(schoolId) || !cleanUuid(leadId) || !LEAD_STATUSES.includes(status)) return null;
  const cfg = await requireSupabase();
  const rows = await rest(
    cfg,
    `/leads?id=eq.${encodeURIComponent(leadId)}&school_id=eq.${encodeURIComponent(schoolId)}&select=id,name,whatsapp,interest,status,source,created_at,updated_at`,
    { method: 'PATCH', prefer: 'return=representation', body: { status, updated_at: new Date().toISOString() } },
  );
  return rows?.[0] ? mapLeadRow(rows[0]) : null;
}

// Akun demo dipakai bersama: nama dan nomor pendaftar asli tidak boleh terlihat utuh.
export function maskLead(lead) {
  const first = (lead.name || '').split(' ')[0] || '';
  const wa = lead.whatsapp || '';
  return {
    ...lead,
    name: first ? `${first.slice(0, 1)}${'*'.repeat(Math.max(2, first.length - 1))}` : '***',
    whatsapp: wa.length > 7 ? `${wa.slice(0, 5)}${'*'.repeat(wa.length - 8)}${wa.slice(-3)}` : '***',
  };
}
