/*
 * Widget Sigi
 *
 * Cara pasang versi produksi (1 baris sebelum </body>, tanpa akses GitHub sekolah):
 *   <script src="https://sigi.domain/widget.js" data-key="sg_pk_live_..." defer></script>
 *
 * Cara pasang versi demo lokal (tetap didukung):
 *   <script src="sekolah/wikrama.js"></script>
 *   <script src="widget.js" defer></script>
 */
(() => {
  'use strict';

  const currentScript = document.currentScript;
  const embedKey = (currentScript?.dataset?.key || window.SigiConfig?.key || '').trim();
  const embedApiBase = (() => {
    const explicit = (currentScript?.dataset?.api || window.SigiConfig?.api || '').trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    if (currentScript?.src) {
      try {
        return new URL(currentScript.src, location.href).origin;
      } catch {
        // fallback ke origin halaman saat ini
      }
    }
    return location.origin;
  })();
  const IS_EMBED = Boolean(embedKey);

  // window.Sigi: data sekolah untuk mode demo lokal. Mode embed (data-key) mengambil konfigurasi dari server Sigi.
  const config = IS_EMBED ? null : (window.Sigi || window.AsistenSPMB);
  if (!IS_EMBED && (!config || !(config.pages || config.context))) {
    console.warn('Sigi: tambahkan atribut data-key="sg_pk_..." pada tag <script> widget.js, atau muat file sekolah/*.js sebelumnya.');
    return;
  }

  // Mode kios (asisten-wikrama.html): <script src="widget.js" data-mode="kiosk">. Tombol chat di pojok disembunyikan,
  // halaman sendiri yang menampilkan percakapan lewat event sigi:* dan memulai telepon lewat SigiWidget.call({ open: false }).
  // Panel widget baru muncul kalau dibuka (misalnya untuk mengisi password atau API key).
  const KIOSK = document.currentScript?.dataset.mode === 'kiosk';

  const API_URL = 'https://api.netra.sh/v1/chat/completions';
  const MODEL = config?.model || 'deepseek/deepseek-v4.1-flash';
  const MAX_CONTEXT_CHARS = 60000;

  // Input suara: speech to text langsung lewat WebSocket Deepgram, pengaturannya sama dengan playground (Tingkat 3).
  // nova-3, Bahasa Indonesia, tanda baca otomatis, teks sementara, dan kalimat ditutup setelah diam 0,5 detik.
  const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen?model=nova-3&language=id&smart_format=true&interim_results=true&endpointing=500&utterance_end_ms=1000';
  const MAX_RECORDING_SECONDS = 60; // rekaman berhenti sendiri, supaya mikrofon tidak lupa dimatikan

  /* Telepon (Tingkat 4): calon murid bicara, Sigi menjawab dengan suara, lalu kembali mendengarkan. */

  const AGENT_NAME = 'Sigi';
  // Text to speech Deepgram, suara Fitri (Bahasa Indonesia). Model Flux hanya tersedia di /v2/speak.
  // Suara Bahasa Indonesia dari Deepgram Flux (Early Access, daftar di developers.deepgram.com/docs/flux-tts/voices).
  // Model Flux hanya tersedia di /v2/speak.
  const VOICES = [
    { id: 'flux-fitri-id', name: 'Fitri', gender: 'perempuan' },
    { id: 'flux-dewi-id', name: 'Dewi', gender: 'perempuan' },
    { id: 'flux-rizky-id', name: 'Rizky', gender: 'laki-laki' },
    { id: 'flux-fajar-id', name: 'Fajar', gender: 'laki-laki' },
    { id: 'flux-teguh-id', name: 'Teguh', gender: 'laki-laki' },
  ];
  const DEFAULT_VOICE = 'flux-fitri-id';
  // Hanya suara dari daftar di atas yang dipakai; nilai lain (misalnya data lama) kembali ke suara bawaan.
  // Ekspresi suara (parameter expressivity, masih beta): -2 tenang sampai 2 hidup, bilangan bulat. 0 adalah setelan standar Deepgram.
  // Makin jauh dari 0, makin besar risiko kata hilang, terulang, atau salah ucap.
  const EXPRESSIVITY = [
    { value: -2, name: 'Sangat tenang' },
    { value: -1, name: 'Tenang' },
    { value: 0, name: 'Standar' },
    { value: 1, name: 'Lebih hidup' },
    { value: 2, name: 'Paling hidup' },
  ];
  // Bawaan Sigi: Lebih hidup, dipilih setelah suara-suaranya dibandingkan langsung. Di 0 Fitri terdengar kaku.
  const DEFAULT_EXPRESSIVITY = 1;
  // Nilai kosong atau di luar daftar (misalnya data lama) kembali ke bawaan, karena Deepgram menolak nilai yang tidak sah.
  const cleanExpressivity = (value) => EXPRESSIVITY.find((item) => String(item.value) === String(value))?.value ?? DEFAULT_EXPRESSIVITY;
  const speakOptions = (voice, expressivity) => ({
    model: VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE,
    expressivity: cleanExpressivity(expressivity),
  });
  const speakUrl = (voice, expressivity) => {
    const params = new URLSearchParams({ model: VOICES.some((v) => v.id === voice) ? voice : DEFAULT_VOICE, encoding: 'mp3' });
    const level = cleanExpressivity(expressivity);
    if (level !== 0) params.set('expressivity', String(level)); // 0 sama dengan tidak dikirim
    return `https://api.deepgram.com/v2/speak?${params}`;
  };
  // Deepgram menutup koneksi yang 10 detik tidak menerima apa pun. Saat rekaman dijeda (Sigi berpikir
  // atau bicara), tidak ada audio yang terkirim, jadi kita kirim KeepAlive lebih sering dari itu.
  const KEEP_ALIVE_MS = 5000;

  // Ditambahkan di akhir system prompt hanya untuk telepon. Aturan terakhir sengaja mengalahkan
  // aturan Markdown di system prompt chat, karena tanda bintang dan tautan ikut dibacakan oleh suara.
  const CALL_RULES = [
    `Namamu ${AGENT_NAME}.`,
    'Calon murid atau orang tua sedang menelepon, jadi jawabanmu akan dibacakan dengan suara.',
    'Bicaralah seperti CS sekolah yang ramah sedang ngobrol di telepon, bukan seperti membaca pengumuman.',
    'Pakai kalimat pendek, kira-kira paling banyak lima belas kata per kalimat, dan beri koma di tempat orang biasanya mengambil napas.',
    'Boleh memakai kata lisan secukupnya seperti "jadi", "nah", "oke", atau "gitu ya", tapi jangan di setiap kalimat.',
    'Sebut "Kak" paling banyak sekali dalam satu jawaban.',
    'Jawab paling banyak tiga kalimat dan langsung ke intinya. Kalau infonya panjang, sebut dua atau tiga hal yang paling penting, lalu tawarkan untuk melanjutkan, misalnya "mau saya sebutkan sisanya?".',
    'Jangan membuka jawaban dengan sapaan atau ucapan terima kasih sudah menunggu, karena aplikasi sudah mengucapkannya.',
    'Tulis angka, jam, tanggal, dan biaya dengan huruf, misalnya sembilan juta lima ratus ribu rupiah atau pukul delapan pagi. Nomor telepon disebut per kelompok dengan huruf, misalnya nol delapan satu sembilan, nol sembilan dua empat, dua empat satu satu.',
    'Jangan membacakan alamat website atau email huruf demi huruf. Cukup sebut, misalnya, "lewat website SPMB sekolah".',
    'Jangan memakai Markdown, daftar, tanda bintang, tautan, atau simbol lain.',
  ].join('\n');

  // Kalimat jeda seperti CS sungguhan, supaya penelepon tidak mengira sambungannya putus saat jawaban lama.
  const CHECKING_LINES = ['Oke Kak, sebentar ya, saya cek dulu.', 'Baik Kak, saya cek terlebih dahulu ya.', 'Hmm, sebentar ya Kak, saya lihat datanya dulu.'];
  const STILL_CHECKING_LINE = 'Masih saya cek ya Kak, mohon ditunggu sebentar.';
  const THANKS_FOR_WAITING_LINES = ['Makasih sudah menunggu ya Kak.', 'Oke Kak, sudah saya cek ya.'];
  const CHECKING_DELAY_MS = 1000; // jawaban yang datang dalam 1 detik tidak perlu kalimat jeda
  const STILL_CHECKING_DELAY_MS = 6000;
  // Basa-basi dijawab cepat, jadi tidak perlu "sebentar saya cek dulu".
  const SMALL_TALK = /^(halo|hai|oke|ok|baik|siap|sip|iya|ya|makasih|terima kasih)\b/i;

  /* Data sekolah. Bawaannya dari sekolah/*.js; kalau sekolah sudah mengedit lewat dashboard,
     versi dashboard (disimpan di localStorage browser ini, mode demo) yang dipakai. */

  const STORAGE_KEY = `sigi:sekolah:${config?.id || 'default'}`;

  function defaults() {
    if (IS_EMBED) {
      return {
        schoolName: 'Asisten Sekolah',
        colors: { primary: '#0f766e', onPrimary: '#ffffff', accent: '#bef264', onAccent: '#0b1f1d' },
        greeting: 'Halo! Ada yang bisa dibantu seputar pendaftaran sekolah?',
        suggestions: [],
        voiceEnabled: false,
        voice: DEFAULT_VOICE,
        expressivity: DEFAULT_EXPRESSIVITY,
        pages: [],
        documents: [],
        updatedAt: null,
      };
    }
    const pages = config.pages
      ? config.pages.map((page, i) => ({ id: `p${i + 1}`, title: page.title, body: page.body.trim(), updatedAt: null }))
      : [{ id: 'p1', title: 'Info sekolah', body: config.context.trim(), updatedAt: null }];
    const schoolName = config.schoolName || 'Sekolah';
    return {
      schoolName,
      colors: { primary: '#0f766e', onPrimary: '#ffffff', accent: '#bef264', onAccent: '#0b1f1d', ...config.colors },
      greeting: config.greeting || `Halo! Aku Asisten SPMB ${schoolName}. Ada yang bisa dibantu?`,
      suggestions: config.suggestions || [],
      voiceEnabled: true,
      voice: config.voice || DEFAULT_VOICE, // suara Sigi di telepon, bisa diganti di dashboard
      expressivity: cleanExpressivity(config.expressivity), // ekspresi suara telepon, bisa diganti di dashboard
      pages,
      documents: [], // { id, name, size, pages, text, addedAt }
      updatedAt: null,
    };
  }

  function load() {
    const base = defaults();
    if (IS_EMBED) return base;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved === 'object') return { ...base, ...saved, colors: { ...base.colors, ...saved.colors } };
    } catch {
      // localStorage tidak tersedia atau isinya rusak: pakai data bawaan.
    }
    return base;
  }

  // Melempar error kalau penyimpanan browser penuh, supaya dashboard bisa memberi tahu pengguna.
  function save(data) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, updatedAt: Date.now() }));
    refresh();
  }

  function reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // abaikan
    }
    refresh();
  }

  // Semua halaman info sekolah dan teks PDF digabung jadi satu konteks untuk system prompt.
  function compileContext(data) {
    const parts = [`=== INFO ${data.schoolName.toUpperCase()} ===`];
    for (const page of data.pages) {
      if (page.body.trim()) parts.push(`[${page.title.trim() || 'Tanpa judul'}]\n${page.body.trim()}`);
    }
    for (const doc of data.documents) {
      parts.push(`[Dokumen: ${doc.name}]\n${doc.text}`);
    }
    return parts.join('\n\n');
  }

  let school = load();

  function createUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function getVisitorSessionId() {
    const key = 'sigi:visitor-session';
    try {
      const existing = sessionStorage.getItem(key);
      if (existing) return existing;
      const created = createUuid();
      sessionStorage.setItem(key, created);
      return created;
    } catch {
      return createUuid();
    }
  }

  // Semua data widget ada di sini. Tampilan selalu digambar ulang dari state ini.
  const state = {
    isOpen: false,
    openedTracked: false,
    conversationId: createUuid(),
    visitorSessionId: getVisitorSessionId(),
    pendingInputSource: null,
    needsLogin: false, // true di Vercel sebelum password dimasukkan
    apiKey: '', // hanya di memori, hilang saat tab dimuat ulang; SERVER_KEY kalau key dibaca dari .env
    deepgramKey: '', // untuk mic dan telepon, juga hanya di memori atau SERVER_KEY
    deepgramFormOpen: false, // kolom key Deepgram baru ditampilkan saat dibutuhkan
    deepgramFor: 'mic', // 'mic' | 'call': tombol mana yang meminta key Deepgram, untuk tujuan fokus setelah disimpan
    keyPanelOpen: false, // true saat pengguna membuka panel pengaturan API key lewat tombol di header
    history: [], // { role: 'user' | 'assistant', content }
    isLoadingConfig: IS_EMBED, // true selagi mengambil konfigurasi sekolah dari /api/v1/widget/config
    isCheckingServer: false, // true selagi mengecek /api/status pada server lokal/Vercel
    isSending: false,
    error: '',
    voiceStatus: 'idle', // 'idle' | 'connecting' | 'recording' | 'transcribing'
    callStatus: 'off', // 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking'
    callHeard: '', // teks yang sedang didengar Deepgram, tampil di bar panggilan
    callSeconds: 0, // lama panggilan
  };

  // Semua yang hidup selama merekam: WebSocket, mikrofon, perekam, timer, dan teks yang sudah terdengar.
  const dictation = {};

  // Semua benda selama telepon (socket, mikrofon, perekam, audio yang diputar, timer, cache suara,
  // object URL) ada di sini, supaya endCall bisa mematikan semuanya di satu tempat.
  // Setiap panggilan baru memakai objek baru, jadi proses lama yang telat selesai bisa dikenali.
  let call = {};

  /* System prompt: aturan yang sama dengan playground, ditambah nama sekolah */

  function buildSystemPrompt(data = school) {
    const context = compileContext(data).slice(0, MAX_CONTEXT_CHARS);
    const rules = [
      `Kamu adalah customer service ${data.schoolName}.`,
      'Kamu adalah customer service yang ramah, sopan, dan membantu.',
      'Jawab pertanyaan calon murid/orang tua hanya berdasarkan informasi di bagian KONTEKS.',
      'Jika informasinya tidak ada di KONTEKS, katakan terus terang bahwa kamu belum punya informasi itu, lalu sarankan calon murid/orang tua menghubungi CS SPMB dan sebutkan nomor kontaknya dari KONTEKS.',
      'Jangan mengarang biaya, kuota, jadwal, beasiswa, atau kebijakan sekolah.',
      'Jawab singkat dan jelas, dengan bahasa yang dipakai calon murid/orang tua.',
      'Boleh memakai Markdown sederhana: **tebal** untuk info penting, daftar poin atau daftar bernomor untuk langkah dan pilihan, dan tautan [teks](https://...) hanya untuk alamat yang ada di KONTEKS. Jangan memakai tabel, judul (#), atau blok kode.',
    ];
    return `${rules.join('\n')}\n\nKONTEKS:\n${context}`;
  }

  /* Memanggil API Netra */

  // Penanda "pakai key dari server lokal" atau "mode embed data-key". Symbol, jadi tidak pernah terkirim sebagai key mentah.
  const SERVER_KEY = Symbol('key dari .env');
  const EMBED_KEY = Symbol('mode embed data-key');
  const LOCAL_CHAT_URL = '/api/chat';
  const LOCAL_SERVER_DOWN = location.protocol === 'https:'
    ? 'Tidak bisa terhubung ke server Sigi. Periksa koneksi internet.'
    : 'Server lokal Sigi tidak jalan. Nyalakan lagi dengan: node server.mjs';

  if (IS_EMBED) {
    state.apiKey = EMBED_KEY;
    state.deepgramKey = EMBED_KEY;
  }

  // Hanya di server lokal (server.mjs) dan Vercel. Di GitHub Pages atau website sekolah, key tetap diketik di halaman.
  // Menukar password dengan cookie sesi (hanya di Vercel). Mengembalikan pesan error, atau '' kalau berhasil.
  async function serverLogin(password) {
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      if (response.ok) return '';
      const data = await response.json().catch(() => null);
      return data?.error?.message ?? `Gagal masuk (kode ${response.status}).`;
    } catch {
      return 'Tidak bisa terhubung ke server Sigi. Periksa koneksi internet.';
    }
  }

  function hasServerBackend() {
    const isLocal = location.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(location.hostname);
    const isVercel = location.protocol === 'https:' && location.hostname.endsWith('.vercel.app');
    return isLocal || isVercel;
  }

  async function serverKeys() {
    if (!hasServerBackend()) return {};
    try {
      const response = await fetch('/api/status', { cache: 'no-store' });
      if (response.ok) return await response.json();
    } catch {
      // ditangani di bawah
    }
    const isVercel = location.protocol === 'https:' && location.hostname.endsWith('.vercel.app');
    return isVercel ? { login: true } : {}; // di Vercel lebih baik minta password daripada minta key
  }

  function buildMeta(channel = 'chat', inputSource = 'typed') {
    return {
      schoolId: config?.id || school.id || 'wikrama',
      schoolName: school.schoolName || config?.schoolName || 'Sekolah',
      periodLabel: config?.periodLabel || '2027-2028',
      conversationId: state.conversationId,
      visitorSessionId: state.visitorSessionId,
      channel,
      inputSource,
    };
  }

  function sendEvent(eventName, { channel = null, metadata = {} } = {}) {
    if (IS_EMBED || !hasServerBackend() || state.needsLogin) return;
    fetch('/api/events', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...buildMeta(channel || 'chat', 'typed'),
        channel,
        eventName,
        metadata,
      }),
    }).catch(() => {});
  }

  function describeApiError(status, data) {
    const code = data?.error?.code;
    const found = [data?.error?.message, data?.error, data?.message, data?.detail].find((item) => typeof item === 'string' && item);
    const message = (found ?? '').slice(0, 200);
    // Error dari server lokal (server.mjs), bukan dari Netra.
    if (code === 'SIGI_NO_KEY' || code === 'SIGI_BAD_KEY') return `${message} Perbaiki file .env (atau env di Vercel), lalu kirim lagi.`;
    if (code === 'SIGI_NETRA_TIMEOUT') return 'Netra terlalu lama menjawab. Coba kirim lagi.';
    if (code === 'SIGI_NETRA_UNREACHABLE') return `Tidak bisa terhubung ke server Netra (${message}). Periksa koneksi internet.`;
    if (code === 'SIGI_LOGIN') {
      useServerKeys(); // menampilkan kolom password lagi, riwayat chat tetap ada
      return data.error.message;
    }
    if (typeof code === 'string' && code.startsWith('SIGI_')) return message || 'Permintaan ditolak oleh server Sigi.';
    // Kode dan pesan asli Netra ikut ditampilkan, supaya penyebabnya bisa dilacak.
    const info = `(kode ${status}${message ? `: ${message}` : ''})`;
    if (status === 403 && (data === null || code === 'NETRA_BLOCKED')) return `Permintaan diblokir sebelum sampai ke Netra ${info}. API key-nya belum tentu bermasalah.`;
    if (status === 401 || status === 403) return `API key ditolak ${info}. Periksa lagi API key-nya${code === 'NETRA' ? ' di env server' : ''}.`;
    if (status === 402) return `Saldo atau kuota API habis ${info}.`;
    if (status === 429) return `Terlalu banyak permintaan ${info}. Tunggu sebentar, lalu kirim lagi.`;
    if (status >= 500) return `Server Netra sedang bermasalah ${info}. Coba lagi beberapa saat lagi.`;
    return `Permintaan gagal ${info}.`;
  }

  async function askAgent(apiKey, messages, meta = null, { mode = 'chat' } = {}) {
    let response;
    try {
      if (apiKey === EMBED_KEY) {
        // Mode embed: kirim hanya riwayat user/assistant. System prompt dan konteks dirakit di server Sigi.
        const publicMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
        response = await fetch(`${embedApiBase}/api/v1/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sigi-Key': embedKey },
          body: JSON.stringify({
            messages: publicMessages,
            mode,
            conversationId: state.conversationId,
            visitorSessionId: state.visitorSessionId,
          }),
        });
      } else {
        // Key dari .env: server lokal yang menambahkan key-nya, jadi browser tidak pernah memegangnya.
        const viaServer = apiKey === SERVER_KEY;
        response = await fetch(viaServer ? LOCAL_CHAT_URL : API_URL, {
          method: 'POST',
          headers: {
            ...(viaServer ? {} : { Authorization: `Bearer ${apiKey}` }),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: MODEL,
            messages,
            // Token penalaran ikut dihitung di max_tokens, jadi batasnya dibuat cukup longgar.
            max_tokens: 2048,
            reasoning: { enabled: true },
            ...(viaServer && meta ? { meta } : {}),
          }),
        });
      }
    } catch {
      throw new Error(apiKey === SERVER_KEY || apiKey === EMBED_KEY
        ? LOCAL_SERVER_DOWN
        : 'Tidak bisa terhubung ke server Netra. Periksa koneksi internet.');
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(describeApiError(response.status, data));

    const reply = apiKey === EMBED_KEY
      ? data?.reply?.trim()
      : data?.choices?.[0]?.message?.content?.trim();
    if (!reply) throw new Error('Asisten tidak mengirim jawaban. Coba kirim ulang pertanyaannya.');
    return reply;
  }

  /* Font dan gaya. Widget hidup di Shadow DOM, jadi CSS website sekolah tidak bisa merusaknya. */

  if (!document.querySelector('link[data-sigi-font]')) {
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap';
    font.dataset.sigiFont = '';
    document.head.append(font);
  }

  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22M8 22h8"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    phoneOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><path d="M22 2 2 22"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    chevronRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>',
    chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>',
  };

  const STYLE = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    p { margin: 0; }
    .root {
      /* --primary, --on-primary, --accent, --on-accent diisi dari data sekolah oleh applySchool(). */
      --surface: #ffffff;
      --canvas: #f8fafc;
      --subtle: #f1f5f9;
      --border: #e2e8f0;
      --border-strong: #cbd5e1;
      --ink: #0f172a;
      --ink-secondary: #334155;
      --ink-muted: #526071;
      font-family: "Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 14px; line-height: 1.5; color: var(--ink);
      -webkit-font-smoothing: antialiased;
    }
    button, input, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; }
    :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

    .launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; align-items: center; gap: 10px; }
    .launcher-label {
      padding: 10px 16px; border: 1px solid var(--border); border-radius: 999px;
      background: var(--surface); color: var(--ink); font-weight: 600; font-size: 13px;
      box-shadow: 0 10px 28px -8px rgb(15 23 42 / 0.16), 0 2px 6px rgb(15 23 42 / 0.06);
      cursor: pointer; transition: transform 0.16s ease, box-shadow 0.16s ease;
    }
    .launcher-label:hover { transform: translateY(-1px); box-shadow: 0 14px 30px -8px rgb(15 23 42 / 0.2), 0 2px 8px rgb(15 23 42 / 0.08); }
    .launcher-btn {
      width: 56px; height: 56px; border: 0; border-radius: 999px;
      background: var(--primary); color: var(--accent);
      display: grid; place-items: center;
      box-shadow: 0 14px 32px -6px rgb(15 23 42 / 0.32), 0 4px 10px -2px rgb(15 23 42 / 0.14);
      transition: transform 0.16s ease, box-shadow 0.16s ease;
    }
    .launcher-btn:hover { transform: translateY(-1px) scale(1.03); box-shadow: 0 18px 36px -6px rgb(15 23 42 / 0.36); }
    .launcher-btn:active { transform: scale(0.97); }
    .launcher-btn svg { width: 24px; height: 24px; }
    .launcher-btn .icon-close { display: none; }
    .root[data-open="true"] .launcher-label { display: none; }
    .root[data-open="true"] .launcher-btn .icon-chat { display: none; }
    .root[data-open="true"] .launcher-btn .icon-close { display: block; }

    .panel {
      position: fixed; right: 20px; bottom: 88px; z-index: 2147483000;
      width: 400px; max-width: calc(100vw - 32px); height: min(650px, calc(100vh - 112px));
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--surface); border: 1px solid rgb(15 23 42 / 0.09); border-radius: 22px;
      box-shadow: 0 24px 64px -16px rgb(15 23 42 / 0.24), 0 6px 18px -6px rgb(15 23 42 / 0.1);
      transform-origin: bottom right;
      animation: sigi-panel-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .panel[hidden] { display: none; }
    @keyframes sigi-panel-in {
      from { opacity: 0; transform: translateY(8px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .header {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 10px 12px 16px;
      background: var(--primary); color: var(--on-primary);
    }
    .avatar {
      width: 36px; height: 36px; flex-shrink: 0; display: grid; place-items: center;
      border-radius: 12px; background: var(--accent); color: var(--on-accent);
    }
    .avatar svg { width: 19px; height: 19px; }
    .header-text { flex: 1; min-width: 0; }
    .title { font-size: 14.5px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.25; }
    .subtitle { font-size: 12px; opacity: 0.88; line-height: 1.3; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .header-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
    .header :focus-visible { outline-color: var(--on-primary); }

    .call-pill {
      min-height: 44px; padding: 0 11px; flex-shrink: 0;
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid color-mix(in srgb, var(--on-primary) 24%, transparent);
      border-radius: 999px;
      background: color-mix(in srgb, var(--on-primary) 12%, transparent);
      color: var(--on-primary); font-size: 12.5px; font-weight: 600;
      transition: background 0.14s ease, border-color 0.14s ease;
    }
    .call-pill:hover:not(:disabled) {
      background: color-mix(in srgb, var(--on-primary) 22%, transparent);
      border-color: color-mix(in srgb, var(--on-primary) 36%, transparent);
    }
    .call-pill:disabled { opacity: 0.45; }
    .call-pill[hidden], .mic[hidden] { display: none; }
    .call-pill svg { width: 15px; height: 15px; flex-shrink: 0; }

    .icon-btn {
      width: 36px; height: 44px; flex-shrink: 0; display: grid; place-items: center;
      border: 0; border-radius: 10px; background: transparent; color: inherit;
      transition: background 0.14s ease, opacity 0.14s ease;
    }
    .icon-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--on-primary) 14%, transparent); }
    .icon-btn[aria-expanded="true"] { background: color-mix(in srgb, var(--on-primary) 20%, transparent); }
    .icon-btn:disabled { opacity: 0.4; background: transparent; }
    .icon-btn[hidden] { display: none; }
    .icon-btn svg { width: 17px; height: 17px; }

    /* Panel akses/API key adaptif: bersih dan menyatu, tersembunyi otomatis saat siap. */
    .access {
      padding: 12px 14px; background: var(--canvas); border-bottom: 1px solid var(--border);
    }
    .access[hidden] { display: none; }
    .access-card {
      padding: 12px; border: 1px solid var(--border); border-radius: 14px;
      background: var(--surface); box-shadow: 0 1px 3px rgb(15 23 42 / 0.04);
    }
    .access-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .access-title { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 700; color: var(--ink); }
    .access-title svg { width: 15px; height: 15px; color: var(--primary); flex-shrink: 0; }
    .access-desc { margin-top: 4px; font-size: 12px; color: var(--ink-muted); line-height: 1.45; }
    .access-close {
      width: 32px; height: 32px; margin: -4px -4px -4px 0; flex-shrink: 0;
      display: grid; place-items: center; border: 0; border-radius: 8px;
      background: transparent; color: var(--ink-muted);
    }
    .access-close:hover { background: var(--subtle); color: var(--ink); }
    .access-close svg { width: 15px; height: 15px; }
    .access form { display: flex; gap: 8px; margin-top: 10px; }
    .access input {
      flex: 1; min-width: 0; height: 44px; padding: 0 12px;
      border: 1px solid var(--border-strong); border-radius: 11px;
      background: var(--surface); color: var(--ink); font-size: 13.5px;
      transition: border-color 0.14s ease, box-shadow 0.14s ease;
    }
    .access input::placeholder { color: var(--ink-muted); }
    .access input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 16%, transparent); }
    .access button[type="submit"] {
      height: 44px; padding: 0 15px; flex-shrink: 0; border: 0; border-radius: 11px;
      background: var(--primary); color: var(--on-primary); font-size: 13px; font-weight: 600;
      transition: opacity 0.14s ease;
    }
    .access button[type="submit"]:hover:not(:disabled) { opacity: 0.92; }
    .access button[type="submit"]:disabled { opacity: 0.55; }
    .access-row {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 6px 0; font-size: 12.5px; color: var(--ink-secondary);
    }
    .access-row + .access-row { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px; }
    .access-row-block { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
    .link-btn {
      min-height: 36px; padding: 0 10px; flex-shrink: 0;
      border: 1px solid var(--border); border-radius: 9px;
      background: var(--canvas); color: var(--ink); font-size: 12px; font-weight: 600;
    }
    .link-btn:hover { background: var(--subtle); border-color: var(--border-strong); }

    /* Area percakapan */
    .messages-wrap { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--canvas); }
    .messages {
      flex: 1; display: flex; flex-direction: column; gap: 14px;
      overflow-y: auto; padding: 16px; scroll-behavior: smooth;
    }

    /* Welcome card saat percakapan belum dimulai */
    .welcome {
      display: flex; flex-direction: column; gap: 14px;
    }
    .welcome-card {
      padding: 16px; border: 1px solid var(--border); border-radius: 18px;
      background: var(--surface); box-shadow: 0 2px 10px -4px rgb(15 23 42 / 0.06);
    }
    .welcome-badge {
      display: inline-flex; align-items: center; gap: 8px; margin-bottom: 10px;
    }
    .welcome-icon {
      width: 28px; height: 28px; display: grid; place-items: center;
      border-radius: 9px; background: color-mix(in srgb, var(--primary) 10%, #ffffff); color: var(--primary);
    }
    .welcome-icon svg { width: 15px; height: 15px; }
    .welcome-name { font-size: 12.5px; font-weight: 700; color: var(--ink-secondary); }
    .welcome-text { font-size: 14.5px; line-height: 1.55; color: var(--ink); }

    .prompts { display: flex; flex-direction: column; gap: 8px; }
    .prompts-label { font-size: 12px; font-weight: 600; color: var(--ink-muted); padding: 0 2px; }
    .prompt-btn {
      width: 100%; min-height: 44px; padding: 10px 14px;
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      border: 1px solid var(--border); border-radius: 13px;
      background: var(--surface); color: var(--ink);
      font-size: 13.5px; font-weight: 500; text-align: left;
      box-shadow: 0 1px 2px rgb(15 23 42 / 0.03);
      transition: background 0.14s ease, border-color 0.14s ease, transform 0.12s ease;
    }
    .prompt-btn:hover {
      background: color-mix(in srgb, var(--primary) 5%, #ffffff);
      border-color: color-mix(in srgb, var(--primary) 34%, var(--border));
    }
    .prompt-btn:active { transform: scale(0.99); }
    .prompt-btn svg { width: 16px; height: 16px; flex-shrink: 0; color: var(--ink-muted); transition: transform 0.14s ease, color 0.14s ease; }
    .prompt-btn:hover svg { color: var(--primary); transform: translateX(2px); }

    /* Gelembung percakapan */
    .row { display: flex; align-items: flex-end; gap: 8px; }
    .row.user { justify-content: flex-end; }
    .mini-avatar {
      width: 28px; height: 28px; flex-shrink: 0; display: grid; place-items: center;
      border-radius: 10px; background: var(--primary); color: var(--accent);
      margin-bottom: 2px;
    }
    .mini-avatar svg { width: 15px; height: 15px; }
    .msg-col { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; max-width: 84%; min-width: 0; }
    .row.user .msg-col { align-items: flex-end; }
    .bubble {
      position: relative; max-width: 100%; padding: 10px 14px;
      border-radius: 16px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55;
    }
    .row.user .bubble {
      border-bottom-right-radius: 5px;
      background: var(--primary); color: var(--on-primary);
    }
    .row.bot .bubble {
      border: 1px solid var(--border); border-bottom-left-radius: 5px;
      background: var(--surface); color: var(--ink);
      box-shadow: 0 1px 2px rgb(15 23 42 / 0.04);
    }
    .row-enter { animation: sigi-bubble-in 180ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    @keyframes sigi-bubble-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    .stream-tok { animation: sigi-tok-in 160ms cubic-bezier(0.22, 1, 0.36, 1) both; }
    @keyframes sigi-tok-in { from { opacity: 0; } to { opacity: 1; } }
    .md [hidden], .stream-tok[hidden] { display: none; }

    .msg-actions { display: flex; align-items: center; gap: 4px; padding-left: 2px; }
    .copy-btn {
      min-height: 28px; padding: 3px 8px;
      display: inline-flex; align-items: center; gap: 5px;
      border: 0; border-radius: 8px; background: transparent;
      color: var(--ink-muted); font-size: 12px; font-weight: 500;
      transition: background 0.14s ease, color 0.14s ease;
    }
    .copy-btn:hover { background: var(--subtle); color: var(--ink); }
    .copy-btn[data-copied="true"] { color: #15803d; }
    .copy-btn svg { width: 13px; height: 13px; flex-shrink: 0; }

    /* Skeleton loading saat mengambil data dari server/database atau menunggu balasan AI */
    .skel {
      display: block; border-radius: 7px;
      background: linear-gradient(90deg, #e2e8f0 25%, #f1f5f9 50%, #e2e8f0 75%);
      background-size: 200% 100%;
      animation: sigi-shimmer 1.4s ease-in-out infinite;
    }
    .skel-on-primary {
      display: block; border-radius: 6px;
      background: linear-gradient(90deg, color-mix(in srgb, var(--on-primary) 18%, transparent) 25%, color-mix(in srgb, var(--on-primary) 34%, transparent) 50%, color-mix(in srgb, var(--on-primary) 18%, transparent) 75%);
      background-size: 200% 100%;
      animation: sigi-shimmer 1.4s ease-in-out infinite;
    }
    @keyframes sigi-shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .skel-reply { display: flex; flex-direction: column; gap: 8px; width: 224px; max-width: 100%; padding: 4px 0; }
    .skel-line { height: 11px; }
    .skel-stack { display: flex; flex-direction: column; gap: 10px; }
    .skel-prompt { height: 44px; border-radius: 13px; border: 1px solid var(--border); background: var(--surface); display: flex; align-items: center; padding: 0 14px; }

    .md { white-space: normal; }
    .md > * + * { margin-top: 8px; }
    .md ul, .md ol { margin: 0; padding-left: 20px; }
    .md li + li, .md li > ul, .md li > ol { margin-top: 4px; }
    .md strong, .md .md-heading { font-weight: 700; }
    .md code { padding: 1px 5px; border-radius: 6px; background: var(--subtle); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    .md a { color: var(--primary); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }

    .error {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 10px 12px; border: 1px solid #fecaca; border-radius: 13px;
      background: #fef2f2; color: #991b1b; font-size: 13px; line-height: 1.45;
    }
    .error svg { width: 16px; height: 16px; flex-shrink: 0; margin-top: 2px; }

    /* Tombol gulir cepat ke pesan terbaru */
    .scroll-bottom {
      position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
      min-height: 36px; padding: 0 13px;
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid var(--border-strong); border-radius: 999px;
      background: var(--surface); color: var(--ink);
      font-size: 12px; font-weight: 600;
      box-shadow: 0 8px 20px -4px rgb(15 23 42 / 0.16), 0 2px 6px rgb(15 23 42 / 0.08);
      transition: background 0.14s ease, transform 0.14s ease;
    }
    .scroll-bottom:hover { background: var(--canvas); transform: translateX(-50%) translateY(-1px); }
    .scroll-bottom[hidden] { display: none; }
    .scroll-bottom svg { width: 15px; height: 15px; }

    /* Composer terpadu bergaya kapsul */
    .voice-status {
      display: flex; align-items: center; gap: 7px;
      padding: 8px 14px 2px; background: var(--surface);
      border-top: 1px solid var(--border);
      color: var(--ink-secondary); font-size: 12px; font-weight: 600;
    }
    .voice-status[hidden] { display: none; }
    .voice-status + .composer { border-top: 0; padding-top: 6px; }

    .composer { padding: 10px 12px 6px; border-top: 1px solid var(--border); background: var(--surface); }
    .composer-box {
      display: flex; align-items: flex-end; gap: 4px;
      padding: 4px 4px 4px 14px;
      border: 1px solid var(--border-strong); border-radius: 18px;
      background: var(--canvas);
      transition: border-color 0.14s ease, background 0.14s ease, box-shadow 0.14s ease;
    }
    .composer-box:focus-within {
      background: var(--surface); border-color: var(--primary);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 16%, transparent);
    }
    .composer textarea {
      flex: 1; min-width: 0; min-height: 44px; max-height: 120px;
      padding: 11px 4px 11px 0; border: 0; background: transparent;
      color: var(--ink); line-height: 1.45; resize: none; outline: none;
    }
    .composer textarea::placeholder { color: var(--ink-muted); }

    .mic {
      width: 40px; height: 44px; flex-shrink: 0; display: grid; place-items: center;
      border: 0; border-radius: 13px; background: transparent; color: var(--ink-secondary);
      transition: background 0.14s ease, color 0.14s ease;
    }
    .mic:hover:not(:disabled) { background: var(--subtle); color: var(--primary); }
    .mic svg { width: 19px; height: 19px; }
    .mic .icon-stop { display: none; }
    /* Selama merekam: merah tua kontras tinggi agar jelas sedang merekam dan mudah dihentikan. */
    .mic[data-recording="true"] { background: #b91c1c; color: #ffffff; }
    .mic[data-recording="true"]:hover:not(:disabled) { background: #991b1b; color: #ffffff; }
    .mic[data-recording="true"] .icon-mic { display: none; }
    .mic[data-recording="true"] .icon-stop { display: block; }
    .mic:disabled { color: #94a3b8; background: transparent; }

    .send {
      width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center;
      border: 0; border-radius: 13px; background: var(--accent); color: var(--on-accent);
      transition: filter 0.14s ease, transform 0.12s ease;
    }
    .send:hover:not(:disabled) { filter: brightness(0.95); }
    .send:active:not(:disabled) { transform: scale(0.96); }
    .send svg { width: 19px; height: 19px; }
    .send:disabled { background: var(--border); color: #64748b; }
    .composer[hidden], .call-bar[hidden], .call-heard[hidden] { display: none; }

    /* Bar panggilan suara modern */
    .call-bar { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 6px; border-top: 1px solid var(--border); background: var(--surface); }
    .call-card {
      display: flex; flex-direction: column; gap: 10px;
      padding: 12px; border-radius: 16px;
      border: 1px solid color-mix(in srgb, var(--primary) 18%, var(--border));
      background: color-mix(in srgb, var(--primary) 5%, #ffffff);
    }
    .call-row { display: flex; align-items: center; gap: 10px; }
    .call-badge {
      width: 38px; height: 38px; flex-shrink: 0; display: grid; place-items: center;
      border-radius: 12px; background: var(--primary); color: var(--accent);
    }
    .call-badge svg { width: 18px; height: 18px; }
    .call-info { flex: 1; min-width: 0; }
    .call-state { color: var(--ink); font-size: 13px; font-weight: 700; line-height: 1.35; }
    .call-time { color: var(--ink-muted); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 1px; }
    .call-heard {
      max-height: 68px; overflow-y: auto; padding: 8px 11px;
      border: 1px solid var(--border); border-radius: 11px;
      background: var(--surface); color: var(--ink); font-size: 13px; overflow-wrap: anywhere;
    }
    /* Merah tua di atas putih: kontras sekitar 6,5:1, jadi tetap terbaca walau warna sekolah apa pun. */
    .call-end {
      min-height: 44px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center;
      gap: 6px; padding: 0 14px; border: 0; border-radius: 999px;
      background: #b91c1c; color: #ffffff; font-size: 13px; font-weight: 700;
      transition: background 0.14s ease;
    }
    .call-end:hover { background: #991b1b; }
    .call-end svg { width: 17px; height: 17px; flex-shrink: 0; }
    .call-note { color: var(--ink-muted); font-size: 11.5px; padding: 0 2px; }

    .footer { padding: 4px 12px 10px; background: var(--surface); color: var(--ink-muted); font-size: 11.5px; text-align: center; }
    .footer a { color: var(--ink-secondary); font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }

    @media (max-width: 480px) {
      .panel { inset: 0; width: auto; max-width: none; height: auto; border: 0; border-radius: 0; animation: none; }
      .root[data-open="true"] .launcher { display: none; }
      .launcher-label { display: none; }
      .header { padding: 10px 8px 10px 12px; gap: 8px; }
      .call-pill { padding: 0 10px; font-size: 12px; }
      .icon-btn { width: 34px; }
      /* iPhone otomatis nge-zoom kalau huruf di kolom isian di bawah 16px. */
      .composer textarea, .access input { font-size: 16px; }
      .footer { padding-bottom: max(10px, env(safe-area-inset-bottom)); }
    }

    @media (prefers-reduced-motion: reduce) {
      .panel, .typing span, .row-enter, .stream-tok, .skel, .skel-on-primary { animation: none; }
      .skel { background: #e2e8f0; }
      .skel-on-primary { background: color-mix(in srgb, var(--on-primary) 24%, transparent); }
      .messages { scroll-behavior: auto; }
      .launcher-label, .launcher-btn, .prompt-btn, .prompt-btn svg, .scroll-bottom, .send { transition: none; }
    }
  `;

  // Kerangka statis widget. Tidak ada data dari pengguna atau AI di sini, jadi aman memakai innerHTML.
  // Semua teks yang berubah-ubah (nama sekolah, pesan, error) dimasukkan lewat textContent.
  const MARKUP = `
    <div class="root" data-open="false">
      <div class="launcher">
        <span class="launcher-label" aria-hidden="true" data-ref="launcherLabel">Tanya soal SPMB?</span>
        <button class="launcher-btn" type="button" aria-expanded="false" aria-controls="asisten-panel" aria-label="Buka Asisten SPMB" data-ref="launcher">
          <span class="icon-chat">${ICONS.chat}</span><span class="icon-close">${ICONS.close}</span>
        </button>
      </div>
      <section class="panel" id="asisten-panel" role="dialog" aria-labelledby="asisten-title" hidden data-ref="panel">
        <header class="header">
          <span class="avatar">${ICONS.bot}</span>
          <div class="header-text">
            <p class="title" id="asisten-title">Asisten SPMB</p>
            <p class="subtitle" data-ref="school"></p>
          </div>
          <div class="header-actions">
            <button class="call-pill" type="button" aria-label="Telepon Sigi" title="Telepon Sigi" data-ref="phone">${ICONS.phone}<span>Telepon</span></button>
            <button class="icon-btn" type="button" aria-label="Pengaturan kunci API" title="Pengaturan kunci API" aria-expanded="false" hidden data-ref="keyToggle">${ICONS.key}</button>
            <button class="icon-btn" type="button" aria-label="Mulai percakapan baru" title="Mulai percakapan baru" data-ref="reset">${ICONS.reset}</button>
            <button class="icon-btn" type="button" aria-label="Tutup Asisten SPMB" title="Tutup" data-ref="close">${ICONS.close}</button>
          </div>
        </header>
        <div class="access" data-ref="demo" hidden></div>
        <div class="messages-wrap">
          <div class="messages" data-ref="messages"></div>
          <button class="scroll-bottom" type="button" hidden data-ref="scrollBottom" aria-label="Gulir ke pesan terbaru">${ICONS.chevronDown}<span>Pesan terbaru</span></button>
        </div>
        <p class="sr-only" role="status" aria-live="polite" data-ref="status"></p>
        <p class="voice-status" data-ref="voiceStatus" hidden></p>
        <form class="composer" data-ref="form">
          <div class="composer-box">
            <label class="sr-only" for="asisten-input">Tulis pertanyaan</label>
            <textarea id="asisten-input" rows="1" placeholder="Tulis pertanyaan..." data-ref="input"></textarea>
            <!-- type="button": tanpa ini, tombol di dalam form dianggap tombol kirim. -->
            <button class="mic" type="button" aria-label="Rekam suara" data-ref="mic"><span class="icon-mic">${ICONS.mic}</span><span class="icon-stop">${ICONS.stop}</span></button>
            <button class="send" type="submit" aria-label="Kirim pertanyaan" data-ref="send">${ICONS.send}</button>
          </div>
        </form>
        <div class="call-bar" data-ref="callBar" hidden>
          <div class="call-card">
            <div class="call-row">
              <span class="call-badge">${ICONS.phone}</span>
              <div class="call-info">
                <!-- Hanya status yang diumumkan pembaca layar. Lama panggilan dan teks yang terdengar
                     sengaja di luar area ini, supaya tidak dibacakan setiap detik. -->
                <p class="call-state" role="status" aria-live="polite" data-ref="callState"></p>
                <p class="call-time"><span class="sr-only">Lama panggilan </span><span data-ref="callTime">0:00</span></p>
              </div>
              <button class="call-end" type="button" data-ref="callEnd">${ICONS.phoneOff}<span>Akhiri</span></button>
            </div>
            <p class="call-heard" data-ref="callHeard" hidden></p>
          </div>
          <p class="call-note">Suara kamu dikirim ke Deepgram untuk diubah jadi teks.</p>
        </div>
        <p class="footer">Jawaban dibuat AI dari info sekolah · Didukung <a data-ref="powered" target="_blank" rel="noopener">Sigi</a></p>
      </section>
    </div>
  `;

  const host = document.createElement('div');
  host.id = 'sigi-widget';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const template = document.createElement('template');
  template.innerHTML = MARKUP;
  shadow.append(style, template.content.cloneNode(true));
  host.hidden = KIOSK;
  document.body.append(host);

  const root = shadow.querySelector('.root');
  const ref = {};
  for (const node of shadow.querySelectorAll('[data-ref]')) ref[node.dataset.ref] = node;

  ref.powered.href = config?.poweredByUrl || (IS_EMBED ? `${embedApiBase}/index.html` : 'index.html');

  // Nama dan warna sekolah dipasang ulang setiap kali data berubah (misalnya setelah disimpan di dashboard).
  function applySchool() {
    root.style.setProperty('--primary', school.colors.primary);
    root.style.setProperty('--on-primary', school.colors.onPrimary);
    root.style.setProperty('--accent', school.colors.accent);
    root.style.setProperty('--on-accent', school.colors.onAccent);
    if (state.isLoadingConfig) {
      const bar = document.createElement('span');
      bar.className = 'skel-on-primary';
      bar.style.width = '118px';
      bar.style.height = '11px';
      bar.style.marginTop = '3px';
      bar.setAttribute('aria-hidden', 'true');
      ref.school.replaceChildren(bar);
    } else {
      ref.school.textContent = school.schoolName;
    }
    ref.panel.setAttribute('aria-label', `Asisten SPMB ${school.schoolName}`);
  }
  applySchool();

  /* Bantuan kecil untuk membuat elemen */

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* Markdown sederhana untuk jawaban asisten.
     Dibuat sendiri (tanpa library) dan hanya memakai createElement, textContent, dan text node,
     tidak pernah innerHTML, jadi jawaban AI tetap tidak bisa menjalankan kode (XSS).
     Didukung: paragraf, **tebal**, *miring*, `kode`, daftar poin, daftar bernomor (boleh bertingkat),
     judul (#) yang ditampilkan sebagai teks tebal, dan tautan http(s), mailto, serta tel. */

  const INLINE_MARKDOWN = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,!?;:'"])/g;
  const LIST_ITEM = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;
  const HEADING = /^\s*#{1,6}\s+(.*)$/;

  // Tautan hanya untuk alamat web, email, dan telepon. Skema lain (javascript:, data:) ditampilkan sebagai teks biasa.
  function markdownLink(text, href) {
    if (!/^(https?:\/\/|mailto:|tel:)/i.test(href)) return document.createTextNode(text);
    const link = make('a', '', text);
    link.href = href;
    if (/^https?:/i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    return link;
  }

  function appendInline(parent, text) {
    let last = 0;
    for (const match of text.matchAll(INLINE_MARKDOWN)) {
      if (match.index > last) parent.append(text.slice(last, match.index));
      const [, bold, code, linkText, linkHref, italic, url] = match;
      if (bold) {
        const strong = make('strong');
        appendInline(strong, bold);
        parent.append(strong);
      } else if (code) {
        parent.append(make('code', '', code));
      } else if (linkText) {
        parent.append(markdownLink(linkText, linkHref));
      } else if (italic) {
        const em = make('em');
        appendInline(em, italic);
        parent.append(em);
      } else if (url) {
        parent.append(markdownLink(url, url));
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  // Membaca satu daftar mulai dari baris start. Mengembalikan [elemen daftar, indeks baris berikutnya].
  function parseList(lines, start) {
    const first = lines[start].match(LIST_ITEM);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const list = make(ordered ? 'ol' : 'ul');
    const startNumber = parseInt(first[2], 10);
    if (ordered && startNumber !== 1) list.start = startNumber;

    let i = start;
    let item = null;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        // Baris kosong di antara butir tidak memutus daftar (model sering memberi jarak antarbutir).
        const next = lines.slice(i + 1).find((candidate) => candidate.trim());
        const nextItem = next?.match(LIST_ITEM);
        if (nextItem && nextItem[1].length >= indent) {
          i++;
          continue;
        }
        break;
      }
      const match = line.match(LIST_ITEM);
      if (match) {
        const level = match[1].length;
        if (level > indent && item) {
          const [nested, next] = parseList(lines, i); // daftar bertingkat di dalam butir sebelumnya
          item.append(nested);
          i = next;
          continue;
        }
        if (level < indent || /\d/.test(match[2]) !== ordered) break;
        item = make('li');
        appendInline(item, match[3]);
        list.append(item);
        i++;
        continue;
      }
      if (item && /^\s+/.test(line)) {
        // Baris menjorok tanpa penanda: lanjutan dari butir sebelumnya.
        item.append(make('br'));
        appendInline(item, line.trim());
        i++;
        continue;
      }
      break;
    }
    return [list, i];
  }

  function renderMarkdown(text) {
    const fragment = document.createDocumentFragment();
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        i++; // baris kosong dan garis pemisah (---) dilewati
        continue;
      }
      if (LIST_ITEM.test(line)) {
        const [list, next] = parseList(lines, i);
        fragment.append(list);
        i = next;
        continue;
      }
      const heading = line.match(HEADING);
      if (heading) {
        const title = make('p', 'md-heading');
        appendInline(title, heading[1]);
        fragment.append(title);
        i++;
        continue;
      }
      // Paragraf: baris-baris berurutan sampai baris kosong, daftar, atau judul. Pindah baris jadi <br>.
      const paragraph = make('p');
      let first = true;
      while (i < lines.length && lines[i].trim() && !LIST_ITEM.test(lines[i]) && !HEADING.test(lines[i])) {
        if (!first) paragraph.append(make('br'));
        appendInline(paragraph, lines[i].trim().replace(/^>\s?/, ''));
        first = false;
        i++;
      }
      fragment.append(paragraph);
    }
    return fragment;
  }

  // Versi teks biasa untuk pembaca layar (role="status"), supaya tanda bintang dan pagar tidak ikut dibacakan.
  function stripMarkdown(text) {
    return text
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1')
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, '$1')
      .replace(/^\s*#{1,6}\s+/gm, '')
      .replace(/^\s*[-*•]\s+/gm, '');
  }

  // Teks rapi untuk disalin pengguna (tanpa simbol Markdown, tautan tetap disertakan).
  function copyableText(text) {
    return text
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1')
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])/g, '$1')
      .replace(/^\s*#{1,6}\s+/gm, '');
  }

  async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    document.execCommand('copy');
    helper.remove();
  }

  function miniAvatar() {
    const avatar = make('span', 'mini-avatar');
    avatar.innerHTML = ICONS.bot; // ikon statis, bukan teks dari AI
    return avatar;
  }

  function copyButton(text) {
    const button = make('button', 'copy-btn');
    button.type = 'button';
    button.setAttribute('aria-label', 'Salin jawaban');
    const icon = make('span');
    icon.innerHTML = ICONS.copy;
    const label = make('span', '', 'Salin');
    button.append(icon, label);
    let timer = null;
    button.addEventListener('click', async () => {
      try {
        await copyToClipboard(copyableText(text));
        clearTimeout(timer);
        button.dataset.copied = 'true';
        icon.innerHTML = ICONS.check;
        label.textContent = 'Tersalin';
        ref.status.textContent = 'Jawaban disalin.';
        timer = setTimeout(() => {
          delete button.dataset.copied;
          icon.innerHTML = ICONS.copy;
          label.textContent = 'Salin';
        }, 2000);
      } catch {
        ref.status.textContent = 'Tidak bisa menyalin jawaban.';
      }
    });
    return button;
  }

  function messageRow(role, text, { allowCopy = false, contentFragment = null, animateEnter = false } = {}) {
    const isUser = role === 'user';
    const row = make('div', `row ${isUser ? 'user' : 'bot'}${animateEnter ? ' row-enter' : ''}`);
    const col = make('div', 'msg-col');
    const bubble = make('div', 'bubble');
    // Label untuk pembaca layar, lalu isinya. Pesan pengguna tetap teks biasa (text node);
    // jawaban asisten ditampilkan sebagai Markdown sederhana lewat renderMarkdown (juga tanpa innerHTML).
    bubble.append(make('span', 'sr-only', isUser ? 'Kamu: ' : 'Asisten: '));
    let body = null;
    if (isUser) {
      bubble.append(document.createTextNode(text));
    } else {
      body = make('div', 'md');
      body.append(contentFragment || renderMarkdown(text));
      bubble.append(body);
    }
    col.append(bubble);
    if (!isUser && allowCopy) {
      const actions = make('div', 'msg-actions');
      actions.append(copyButton(text));
      col.append(actions);
    }
    if (!isUser) row.append(miniAvatar());
    row.append(col);
    return { row, body };
  }

  function welcomeBlock(suggestions) {
    const wrap = make('div', 'welcome');
    const card = make('div', 'welcome-card');
    const badge = make('div', 'welcome-badge');
    const icon = make('span', 'welcome-icon');
    icon.innerHTML = ICONS.bot;
    badge.append(icon, make('span', 'welcome-name', `Asisten SPMB · ${school.schoolName}`));
    const greeting = make('div', 'welcome-text md');
    greeting.append(renderMarkdown(school.greeting));
    card.append(badge, greeting);
    wrap.append(card);

    if (suggestions.length > 0) {
      const list = make('div', 'prompts');
      list.append(make('p', 'prompts-label', 'Pertanyaan populer'));
      for (const question of suggestions) {
        const btn = make('button', 'prompt-btn');
        btn.type = 'button';
        const arrow = make('span');
        arrow.innerHTML = ICONS.chevronRight;
        btn.append(make('span', '', question), arrow);
        btn.addEventListener('click', () => {
          sendEvent('suggestion_clicked', { channel: 'chat', metadata: { label: question } });
          send(question, 'suggestion_chip');
        });
        list.append(btn);
      }
      wrap.append(list);
    }
    return wrap;
  }

  function errorBanner(message) {
    const box = make('div', 'error');
    const icon = make('span');
    icon.innerHTML = ICONS.alert;
    box.append(icon, make('span', '', message));
    return box;
  }

  function makeSkel(width, height = '11px', extraClass = 'skel') {
    const bar = make('span', extraClass);
    bar.style.width = width;
    bar.style.height = height;
    bar.setAttribute('aria-hidden', 'true');
    return bar;
  }

  function welcomeSkeleton() {
    const wrap = make('div', 'welcome');
    wrap.setAttribute('aria-busy', 'true');
    wrap.append(make('p', 'sr-only', 'Memuat informasi sekolah dari server Sigi...'));

    const card = make('div', 'welcome-card skel-stack');
    const head = make('div', 'welcome-badge');
    head.append(makeSkel('28px', '28px'), makeSkel('150px', '12px'));
    card.append(head, makeSkel('96%', '12px'), makeSkel('82%', '12px'), makeSkel('58%', '12px'));
    wrap.append(card);

    const list = make('div', 'prompts');
    list.append(makeSkel('108px', '11px'));
    for (const width of ['68%', '56%', '74%']) {
      const item = make('div', 'skel-prompt');
      item.append(makeSkel(width, '12px'));
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  function typingRow() {
    const row = make('div', 'row bot');
    const col = make('div', 'msg-col');
    const bubble = make('div', 'bubble');
    bubble.setAttribute('aria-busy', 'true');
    const lines = make('div', 'skel-reply');
    lines.append(makeSkel('94%', '11px'), makeSkel('80%', '11px'), makeSkel('54%', '11px'));
    bubble.append(make('span', 'sr-only', 'Asisten sedang menulis jawaban'), lines);
    col.append(bubble);
    row.append(miniAvatar(), col);
    return row;
  }

  /* Tampilan */

  // Kolom password / API key di panel akses adaptif.
  function keyForm(placeholder, label, buttonLabel, onSave) {
    const form = make('form');
    const input = make('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    const save = make('button', '', buttonLabel);
    save.type = 'submit';
    form.append(input, save);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      const key = input.value.trim();
      if (!key) {
        input.focus();
        return;
      }
      save.disabled = true; // cegah kirim dua kali selagi password diperiksa
      save.textContent = 'Sebentar';
      await onSave(key);
      save.disabled = false;
      save.textContent = buttonLabel;
    });
    return form;
  }

  function accessHeader(titleText, onClose) {
    const head = make('div', 'access-head');
    const title = make('p', 'access-title');
    const icon = make('span');
    icon.innerHTML = ICONS.key;
    title.append(icon, make('span', '', titleText));
    head.append(title);
    if (onClose) {
      const close = make('button', 'access-close');
      close.type = 'button';
      close.setAttribute('aria-label', 'Tutup pengaturan kunci');
      close.innerHTML = ICONS.close;
      close.addEventListener('click', onClose);
      head.append(close);
    }
    return head;
  }

  function readyRow(text, buttonText, onClick) {
    const row = make('div', 'access-row');
    row.append(make('span', '', text));
    // Selama telepon, key tidak boleh diganti: tombolnya tidak ditampilkan sama sekali, supaya
    // key yang sedang dipakai panggilan tidak dikosongkan.
    if (buttonText && state.callStatus === 'off') {
      const button = make('button', 'link-btn', buttonText);
      button.type = 'button';
      button.addEventListener('click', onClick);
      row.append(button);
    }
    return row;
  }

  function renderDemo() {
    ref.demo.replaceChildren();

    if (IS_EMBED) {
      ref.keyToggle.hidden = true;
      ref.demo.hidden = true;
      return;
    }

    if (state.isCheckingServer) {
      ref.keyToggle.hidden = true;
      ref.demo.hidden = false;
      const skelCard = make('div', 'access-card skel-stack');
      skelCard.setAttribute('aria-busy', 'true');
      skelCard.append(make('span', 'sr-only', 'Memeriksa koneksi server Sigi...'), makeSkel('130px', '12px'), makeSkel('88%', '11px'));
      ref.demo.append(skelCard);
      return;
    }

    const bothFromServer = state.apiKey === SERVER_KEY && state.deepgramKey === SERVER_KEY;
    const canToggleKeys = !state.needsLogin && Boolean(state.apiKey) && !bothFromServer && state.callStatus === 'off';
    const shouldShowPanel = state.needsLogin || !state.apiKey || state.deepgramFormOpen || (state.keyPanelOpen && canToggleKeys);

    ref.keyToggle.hidden = !canToggleKeys;
    ref.keyToggle.setAttribute('aria-expanded', String(shouldShowPanel && canToggleKeys));
    ref.demo.hidden = !shouldShowPanel;
    if (!shouldShowPanel) return;

    const card = make('div', 'access-card');

    if (state.needsLogin) {
      card.append(
        accessHeader('Masuk ke mode demo'),
        make('p', 'access-desc', 'Masukkan password untuk mulai menggunakan Sigi.'),
        keyForm('Masukkan password', 'Password mode demo', 'Masuk', async (password) => {
          const error = await serverLogin(password);
          if (error) {
            showError(error);
            return;
          }
          state.error = '';
          state.keyPanelOpen = false;
          await useServerKeys();
        }),
      );
      ref.demo.append(card);
      return;
    }

    const canClose = Boolean(state.apiKey);
    const closePanel = canClose ? () => {
      state.keyPanelOpen = false;
      state.deepgramFormOpen = false;
      renderDemo();
      ref.input.focus();
    } : null;

    if (!state.apiKey) {
      card.append(
        accessHeader('Aktifkan Asisten', null),
        make('p', 'access-desc', 'Mode demo: masukkan API key Netra untuk mencoba. Key hanya disimpan di tab ini.'),
        keyForm('Tempel API key Netra', 'API key Netra untuk mode demo', 'Pakai', (key) => {
          state.apiKey = key;
          state.error = '';
          state.keyPanelOpen = false;
          renderDemo();
          renderMessages();
          ref.input.focus();
        }),
      );
      ref.demo.append(card);
      return;
    }

    // Jika Netra sudah aktif dan hanya diminta key Deepgram (atau user membuka pengaturan key).
    card.append(accessHeader(state.deepgramFormOpen && !state.keyPanelOpen ? 'Aktifkan fitur suara' : 'Pengaturan kunci API', closePanel));

    if (state.keyPanelOpen) {
      if (state.apiKey === SERVER_KEY) {
        card.append(readyRow('Chat Netra · dibaca dari server'));
      } else {
        card.append(readyRow('Chat Netra · aktif di tab ini', 'Ganti', () => {
          state.apiKey = '';
          state.keyPanelOpen = false;
          renderDemo();
          ref.demo.querySelector('input')?.focus();
        }));
      }
    }

    if (state.deepgramKey === SERVER_KEY) {
      if (state.keyPanelOpen) card.append(readyRow('Suara Deepgram · dibaca dari server'));
    } else if (state.deepgramKey) {
      if (state.keyPanelOpen) {
        card.append(readyRow('Suara Deepgram · aktif di tab ini', 'Ganti', () => {
          state.deepgramKey = '';
          state.deepgramFormOpen = true;
          state.deepgramFor = 'mic';
          renderDemo();
          ref.demo.querySelector('[data-deepgram] input')?.focus();
        }));
      }
    } else if (state.deepgramFormOpen) {
      const wrap = state.keyPanelOpen ? make('div', 'access-row-block') : card;
      const form = keyForm('Tempel API key Deepgram', 'API key Deepgram untuk mic dan telepon', 'Pakai', (key) => {
        state.deepgramKey = key;
        state.deepgramFormOpen = false;
        state.keyPanelOpen = false;
        state.error = '';
        renderDemo();
        renderMessages();
        // Fokus kembali ke tombol yang tadi meminta key, supaya bisa langsung dicoba lagi.
        (state.deepgramFor === 'call' ? ref.phone : ref.mic).focus();
      });
      form.dataset.deepgram = '';
      wrap.append(make('p', 'access-desc', 'Untuk mic dan telepon, masukkan API key Deepgram. Key hanya disimpan di tab ini.'), form);
      if (wrap !== card) card.append(wrap);
    } else if (state.keyPanelOpen) {
      card.append(readyRow('Suara & telepon belum aktif', 'Tambah key', () => {
        state.deepgramFormOpen = true;
        state.deepgramFor = 'mic';
        renderDemo();
        ref.demo.querySelector('[data-deepgram] input')?.focus();
      }));
    }

    ref.demo.append(card);
  }

  function updateScrollButton() {
    const el = ref.messages;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    ref.scrollBottom.hidden = distance < 96;
  }

  // Animasi muncul bertahap 60fps per potongan kata dengan fade-in halus, selesai <= 3,2 detik (WCAG 2.2.2).
  let replyReveal = null;

  const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  function buildRevealTokens(text) {
    const fragment = renderMarkdown(text);
    for (const node of fragment.querySelectorAll('*')) node.hidden = true;
    const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current.nodeValue) textNodes.push(current);
    }
    const tokens = [];
    for (const node of textNodes) {
      const chunks = node.nodeValue.match(/\S{1,4}\s*|\s+/g) || [node.nodeValue];
      const box = document.createDocumentFragment();
      for (const chunk of chunks) {
        const span = make('span', 'stream-tok', chunk);
        span.hidden = true;
        box.append(span);
        tokens.push(span);
      }
      node.replaceWith(box);
    }
    return { fragment, tokens };
  }

  function revealTokensUntil(stateObj, targetCount) {
    const { tokens, bodyEl } = stateObj;
    while (stateObj.shown < targetCount && stateObj.shown < tokens.length) {
      const tok = tokens[stateObj.shown++];
      for (let p = tok.parentElement; p && p !== bodyEl && p.hidden; p = p.parentElement) {
        p.hidden = false;
      }
      tok.hidden = false;
    }
  }

  function cancelReveal({ rerender = false } = {}) {
    if (!replyReveal) return;
    if (replyReveal.raf) cancelAnimationFrame(replyReveal.raf);
    clearTimeout(replyReveal.timer);
    const prevTop = ref.messages.scrollTop;
    const nearBottom = ref.messages.scrollHeight - prevTop - ref.messages.clientHeight < 96;
    replyReveal = null;
    ref.messages.style.scrollBehavior = '';
    if (rerender) {
      renderMessages();
      if (!nearBottom) {
        requestAnimationFrame(() => {
          ref.messages.scrollTop = prevTop;
          updateScrollButton();
        });
      }
    }
  }

  function startReplyReveal(entry) {
    cancelReveal();
    const text = entry?.content || '';
    if (!state.isOpen || state.callStatus !== 'off' || prefersReducedMotion() || text.length < 24) {
      renderMessages();
      return;
    }
    const { fragment, tokens } = buildRevealTokens(text);
    if (tokens.length === 0) {
      renderMessages();
      return;
    }
    const durationMs = Math.min(3000, Math.max(450, text.length * 7.5));
    const current = {
      entry,
      fragment,
      tokens,
      shown: 0,
      bodyEl: null,
      raf: 0,
      timer: null,
    };
    replyReveal = current;
    renderMessages();
    if (!current.bodyEl) {
      cancelReveal();
      return;
    }
    revealTokensUntil(current, 1);
    ref.messages.style.scrollBehavior = 'auto';
    const startedAt = performance.now();

    const frame = (now) => {
      if (replyReveal !== current) return;
      const elapsed = now - startedAt;
      const target = Math.min(tokens.length, Math.max(1, Math.floor((elapsed / durationMs) * tokens.length) + 1));
      const nearBottom = ref.messages.scrollHeight - ref.messages.scrollTop - ref.messages.clientHeight < 96;
      revealTokensUntil(current, target);
      if (nearBottom) {
        ref.messages.scrollTop = ref.messages.scrollHeight;
        updateScrollButton();
      }
      if (current.shown >= tokens.length) {
        current.timer = setTimeout(() => cancelReveal({ rerender: true }), 170);
        return;
      }
      current.raf = requestAnimationFrame(frame);
    };
    current.raf = requestAnimationFrame(frame);
  }

  function renderMessages() {
    const suggestions = school.suggestions.filter((question) => question.trim());
    // Selama telepon, saran pertanyaan disembunyikan karena chat diketik sedang tidak bisa dipakai.
    const showWelcome = state.history.length === 0 && state.callStatus === 'off';

    if (state.isLoadingConfig) {
      ref.messages.replaceChildren(welcomeSkeleton());
    } else if (showWelcome) {
      ref.messages.replaceChildren(welcomeBlock(suggestions));
    } else {
      ref.messages.replaceChildren(messageRow('assistant', school.greeting).row);
      for (const message of state.history) {
        const isRevealing = replyReveal?.entry === message;
        const { row, body } = messageRow(message.role, message.content, {
          allowCopy: message.role === 'assistant' && !isRevealing,
          contentFragment: isRevealing ? replyReveal.fragment : null,
          animateEnter: isRevealing,
        });
        if (isRevealing) replyReveal.bodyEl = body;
        ref.messages.append(row);
      }
    }
    if (state.isSending) ref.messages.append(typingRow());
    if (state.error) ref.messages.append(errorBanner(state.error));

    renderControls();
    requestAnimationFrame(() => {
      ref.messages.scrollTop = ref.messages.scrollHeight;
      updateScrollButton();
    });
  }

  function fitInput() {
    ref.input.style.height = 'auto';
    ref.input.style.height = `${Math.min(ref.input.scrollHeight + 2, 120)}px`;
  }

  function setOpen(isOpen) {
    state.isOpen = isOpen;
    if (KIOSK) host.hidden = !isOpen;
    root.dataset.open = String(isOpen);
    ref.panel.hidden = !isOpen;
    ref.launcher.setAttribute('aria-expanded', String(isOpen));
    ref.launcher.setAttribute('aria-label', isOpen ? 'Tutup Asisten SPMB' : 'Buka Asisten SPMB');
    if (isOpen) {
      if (!state.openedTracked) {
        state.openedTracked = true;
        sendEvent('widget_opened');
      }
      renderDemo();
      renderMessages();
      // Selama telepon, kolom pertanyaan disembunyikan, jadi fokus ke tombol Akhiri.
      if (state.callStatus !== 'off') ref.callEnd.focus();
      else (state.apiKey ? ref.input : (ref.demo.querySelector('input') ?? ref.input)).focus();
    } else {
      cancelReveal();
      // Widget ditutup saat merekam: mikrofon langsung dimatikan, tanpa mengirim apa pun.
      if (state.voiceStatus !== 'idle') cancelRecording();
      // Widget ditutup saat menelepon: panggilan diakhiri biasa, bukan dianggap error.
      if (state.callStatus !== 'off') endCall();
      ref.launcher.focus();
    }
  }

  /* Mengirim pertanyaan */

  async function send(rawQuestion, sourceOverride) {
    const question = rawQuestion.trim();
    // Selama telepon, pertanyaan diketik diabaikan: riwayat sedang dipakai oleh panggilan.
    if (!question || state.isSending || state.voiceStatus !== 'idle' || state.callStatus !== 'off') return;
    cancelReveal({ rerender: true });

    if (!state.apiKey) {
      ref.input.value = question;
      fitInput();
      state.error = `Masukkan ${state.needsLogin ? 'password' : 'API key Netra'} dulu di panel akses di atas.`;
      renderDemo();
      renderMessages();
      ref.demo.querySelector('input')?.focus();
      return;
    }

    const inputSource = sourceOverride || state.pendingInputSource || 'typed';
    state.pendingInputSource = null;
    const channel = inputSource === 'mic' ? 'mic' : 'chat';

    state.error = '';
    state.history.push({ role: 'user', content: question });
    ref.input.value = '';
    fitInput();
    state.isSending = true;
    emitState('thinking');
    renderMessages();
    ref.status.textContent = 'Asisten sedang menulis jawaban.';

    // Riwayat chat ikut dikirim setiap kali, karena API tidak mengingat percakapan sebelumnya.
    const messages = [{ role: 'system', content: buildSystemPrompt() }, ...state.history];

    let revealedEntry = null;
    try {
      const reply = await askAgent(state.apiKey, messages, buildMeta(channel, inputSource));
      revealedEntry = { role: 'assistant', content: reply };
      state.history.push(revealedEntry);
      ref.status.textContent = `Asisten: ${stripMarkdown(reply)}`;
    } catch (error) {
      // Pertanyaan yang gagal dikembalikan ke kolom input supaya bisa langsung dikirim ulang.
      state.history.pop();
      ref.input.value = question;
      fitInput();
      state.error = error.message;
      ref.status.textContent = error.message;
    } finally {
      state.isSending = false;
      emitState('idle');
      if (revealedEntry) startReplyReveal(revealedEntry);
      else renderMessages();
    }
  }

  // Event untuk halaman sekolah (dipakai asisten-wikrama.html). Widget tetap jalan walau tidak ada yang mendengarkan.
  //   sigi:state    { state: 'idle' | 'listening' | 'thinking' | 'speaking' }
  //   sigi:heard    { text }     teks yang sedang didengar dari penelepon (berubah terus selama dia bicara)
  //   sigi:question { text }     pertanyaan final yang akan dijawab
  //   sigi:say      { text }     kalimat yang mulai diucapkan Sigi (salam, kalimat jeda, atau jawaban)
  //   sigi:audio    { audio }    elemen audio suara Sigi, misalnya untuk menggerakkan mulut maskot
  //   sigi:error    { message, needsKey }
  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(`sigi:${name}`, { detail }));
  }
  function emitState(value) {
    emit('state', { state: value });
  }

  /* Input suara lewat Deepgram (sama dengan Tingkat 3 di playground) */

  // Nama tombol mic untuk pembaca layar, dan keterangan di atas kolom pertanyaan, per keadaan rekaman.
  const VOICE = {
    idle: { label: 'Rekam suara', text: '' },
    connecting: { label: 'Menyambung ke Deepgram', text: 'Menyambung ke Deepgram...' },
    recording: { label: 'Berhenti merekam dan kirim', text: 'Merekam. Tekan tombol mic lagi untuk berhenti dan mengirim.' },
    transcribing: { label: 'Menunggu teks terakhir', text: 'Menunggu teks terakhir dari Deepgram...' },
  };

  // Tombol mic, tombol kirim, tombol mulai ulang, dan kolom pertanyaan selalu digambar ulang dari state.
  function renderControls() {
    const voice = state.voiceStatus;
    const busy = voice !== 'idle';
    const inCall = state.callStatus !== 'off';
    const loadingCfg = state.isLoadingConfig;
    const allowVoice = !IS_EMBED || Boolean(school.voiceEnabled);
    ref.mic.hidden = !allowVoice;
    ref.phone.hidden = !allowVoice;
    ref.mic.dataset.recording = String(voice === 'recording');
    ref.mic.setAttribute('aria-label', VOICE[voice].label);
    ref.mic.title = VOICE[voice].label;
    // Selama telepon atau memuat konfigurasi, semua tombol chat dimatikan.
    ref.mic.disabled = loadingCfg || inCall || state.isSending || voice === 'connecting' || voice === 'transcribing';
    ref.send.disabled = loadingCfg || inCall || state.isSending || busy;
    ref.reset.disabled = loadingCfg || inCall || state.history.length === 0 || state.isSending || busy;
    ref.phone.disabled = loadingCfg || inCall || state.isSending || busy;
    ref.phone.setAttribute('aria-label', CALL[state.callStatus].label);
    ref.phone.title = CALL[state.callStatus].label;
    // Kolom pertanyaan dikunci selama merekam atau memuat konfigurasi.
    ref.input.readOnly = loadingCfg || busy;
    ref.voiceStatus.hidden = !busy || inCall;
    ref.voiceStatus.textContent = VOICE[voice].text;
    ref.form.hidden = inCall;
    renderCallBar();
  }

  /* Telepon: tampilan */

  // Nama tombol Telepon dan teks status di bar panggilan, per keadaan panggilan.
  const CALL = {
    off: { label: `Telepon ${AGENT_NAME}`, text: '' },
    connecting: { label: 'Panggilan sedang menyambung', text: 'Menyambung...' },
    listening: { label: 'Panggilan sedang berjalan', text: `Silakan bicara. ${AGENT_NAME} mendengarkan.` },
    thinking: { label: 'Panggilan sedang berjalan', text: `${AGENT_NAME} sedang mencari jawaban...` },
    speaking: { label: 'Panggilan sedang berjalan', text: `${AGENT_NAME} sedang bicara...` },
  };

  function formatDuration(seconds) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function renderCallBar() {
    ref.callBar.hidden = state.callStatus === 'off';
    const text = CALL[state.callStatus].text;
    // Teks status hanya diganti kalau berubah, supaya pembaca layar tidak mengumumkan ulang hal yang sama.
    if (ref.callState.textContent !== text) ref.callState.textContent = text;
    ref.callHeard.hidden = !state.callHeard;
    ref.callHeard.textContent = state.callHeard;
    // Kata terbaru ada di bawah; digulir otomatis karena penelepon tidak sedang memegang layar.
    ref.callHeard.scrollTop = ref.callHeard.scrollHeight;
    ref.callTime.textContent = formatDuration(state.callSeconds);
  }

  // Mengganti status panggilan, lalu menggambar ulang bar panggilan dan semua tombol.
  function setCallStatus(status) {
    state.callStatus = status;
    emitState(status === 'off' ? 'idle' : status === 'connecting' ? 'thinking' : status);
    renderControls();
    // Kotak kuning ikut digambar ulang: tombol ganti key disembunyikan selama telepon dan kembali sesudahnya.
    renderDemo();
  }

  function setVoiceStatus(status) {
    state.voiceStatus = status;
    renderControls();
  }

  function showError(message) {
    state.error = message;
    renderMessages();
    ref.status.textContent = message;
  }

  // Membuka mikrofon. Error dari browser diubah jadi pesan yang mudah dipahami.
  async function getMicrophone() {
    // Browser hanya mengizinkan mikrofon di halaman yang aman: https://, localhost, atau file di komputer sendiri.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Mikrofon hanya bisa dipakai di halaman https:// atau localhost.');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Browser ini belum bisa merekam suara. Coba pakai versi terbaru Chrome, Edge, Firefox, atau Safari.');
    }
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
        throw new Error('Izin mikrofon ditolak. Izinkan mikrofon untuk halaman ini lewat ikon di address bar, lalu coba lagi.');
      }
      if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
        throw new Error('Mikrofon tidak ditemukan. Sambungkan mikrofon, lalu coba lagi.');
      }
      if (error.name === 'NotReadableError') {
        throw new Error('Mikrofon sedang dipakai aplikasi lain. Tutup aplikasi itu, lalu coba lagi.');
      }
      throw new Error('Mikrofon tidak bisa dibuka. Coba lagi.');
    }
  }

  // signal: widget ditutup atau panggilan diakhiri selagi menyambung.
  async function openDeepgramSocket(apiKey, signal) {
    let wsToken = apiKey;
    let authScheme = 'token';
    const viaServer = apiKey === SERVER_KEY;

    if (apiKey === EMBED_KEY) {
      let resp;
      try {
        resp = await fetch(`${embedApiBase}/api/v1/voice-token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Sigi-Key': embedKey },
          body: '{}',
          signal,
        });
      } catch {
        throw new Error(LOCAL_SERVER_DOWN);
      }
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.token) {
        throw new Error(describeSpeechError(resp.status, data));
      }
      wsToken = data.token;
      authScheme = data.authScheme || 'bearer';
    }

    return new Promise((resolve, reject) => {
      // Key dari .env: lewat server lokal. Mode embed: pakai token sementara Deepgram. Selain itu: key manual di tab.
      const socket = viaServer
        ? new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/listen${new URL(DEEPGRAM_LIVE_URL).search}`)
        : new WebSocket(DEEPGRAM_LIVE_URL, [authScheme, wsToken]);
      signal?.addEventListener('abort', () => {
        reject(new Error('Dibatalkan.')); // tidak berpengaruh kalau sudah tersambung
        if (socket.readyState === WebSocket.CONNECTING) socket.close();
      }, { once: true });
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => {
        if (viaServer) useServerKeys(); // kalau sesinya habis, kolom password muncul lagi
        reject(new Error(viaServer || apiKey === EMBED_KEY
          ? 'Gagal tersambung ke layanan suara Deepgram. Periksa koneksi internet dan pengaturan suara.'
          : 'Gagal tersambung ke Deepgram. Periksa API key Deepgram dan koneksi internet.'));
      });
    });
  }

  async function startRecording(apiKey, signal) {
    const stream = await getMicrophone();
    const stopMicrophone = () => stream.getTracks().forEach((track) => track.stop());
    signal.addEventListener('abort', stopMicrophone, { once: true }); // langsung mati, tanpa menunggu sambungan
    let socket;
    try {
      if (signal.aborted) throw new Error('Dibatalkan.');
      socket = await openDeepgramSocket(apiKey, signal);
    } catch (error) {
      stopMicrophone();
      throw error;
    }
    if (signal.aborted) {
      stopMicrophone();
      socket.close();
      throw new Error('Dibatalkan.');
    }

    const recorder = new MediaRecorder(stream);
    Object.assign(dictation, {
      socket, stream, recorder, typedText: ref.input.value.trim(), finalText: '', interimText: '', stopping: false, cancelled: false,
    });
    socket.addEventListener('message', handleDictationMessage);
    socket.addEventListener('close', finishRecording);
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(event.data);
    });
    recorder.addEventListener('stop', () => {
      stream.getTracks().forEach((track) => track.stop()); // mematikan mikrofon
      // CloseStream: Deepgram mengirim sisa teks yang belum final, lalu menutup koneksi.
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
      setTimeout(() => socket.close(), 5000); // cadangan kalau Deepgram tidak menutup sendiri
    });
    recorder.start(250); // potongan audio dikirim ke Deepgram setiap 250 milidetik
    dictation.timer = setTimeout(stopRecording, MAX_RECORDING_SECONDS * 1000);
  }

  // Hasil sementara (is_final false) masih bisa berubah, jadi hanya hasil final yang disimpan.
  function collectTranscript(target, data) {
    const text = data.channel?.alternatives?.[0]?.transcript ?? '';
    if (data.is_final) {
      if (text) target.finalText = `${target.finalText} ${text}`.trim();
      target.interimText = '';
    } else {
      target.interimText = text;
    }
    return `${target.finalText} ${target.interimText}`.trim();
  }

  function handleDictationMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.type !== 'Results' || dictation.cancelled) return;
    // Teks muncul di kolom pertanyaan selagi orang bicara, setelah teks yang sudah diketik sebelumnya.
    ref.input.value = `${dictation.typedText} ${collectTranscript(dictation, data)}`.trim();
    fitInput();
  }

  function stopRecording() {
    if (state.voiceStatus !== 'recording') return;
    clearTimeout(dictation.timer);
    dictation.stopping = true;
    dictation.recorder.stop();
    setVoiceStatus('transcribing');
    ref.status.textContent = 'Menunggu teks terakhir dari Deepgram.';
  }

  // Dipakai saat widget ditutup di tengah rekaman: mikrofon dimatikan dan tidak ada yang dikirim.
  function cancelRecording() {
    if (state.voiceStatus === 'connecting') dictation.connecting?.abort();
    if (state.voiceStatus === 'connecting') {
      dictation.cancelled = true; // startRecording akan membatalkan sendiri setelah tersambung
      return;
    }
    if (!dictation.recorder) return;
    clearTimeout(dictation.timer);
    dictation.cancelled = true;
    dictation.stopping = true;
    if (dictation.recorder.state !== 'inactive') dictation.recorder.stop();
    if (dictation.socket.readyState === WebSocket.OPEN) dictation.socket.close();
  }

  // Dipanggil saat koneksi Deepgram tertutup: sesudah CloseStream, karena internet putus, atau karena dibatalkan.
  function finishRecording() {
    if (state.voiceStatus === 'idle') return;
    clearTimeout(dictation.timer);
    if (dictation.recorder.state !== 'inactive') dictation.recorder.stop();
    dictation.stream.getTracks().forEach((track) => track.stop());
    const { typedText, finalText, interimText, stopping, cancelled } = dictation;
    // Kalau koneksi putus tiba-tiba atau rekaman dibatalkan, teks sementara ikut disimpan supaya tidak hilang.
    const heard = stopping && !cancelled ? finalText : `${finalText} ${interimText}`.trim();
    ref.input.value = `${typedText} ${heard}`.trim();
    fitInput();
    setVoiceStatus('idle');
    if (cancelled) {
      ref.status.textContent = 'Rekaman dibatalkan.';
      return;
    }
    ref.mic.focus(); // fokus keyboard kembali ke tombol mic, karena tombol itu sempat dimatikan

    if (!stopping) {
      showError(heard
        ? 'Sambungan ke Deepgram terputus. Teks yang sudah terdengar ada di kolom pertanyaan.'
        : 'Sambungan ke Deepgram terputus. Periksa koneksi internet, lalu coba lagi.');
    } else if (!finalText) {
      showError('Suara tidak terdengar jelas. Dekatkan mikrofon, lalu coba lagi.');
    } else {
      // Teks hasil rekaman dikirim lewat jalur yang sama dengan pertanyaan yang diketik
      // (termasuk pengecekan API key Netra dan tampilan error).
      sendEvent('mic_used', { channel: 'mic' });
      state.pendingInputSource = 'mic';
      send(ref.input.value);
    }
  }

  async function handleMicClick() {
    if (state.voiceStatus === 'recording') {
      stopRecording();
      return;
    }
    if (state.voiceStatus !== 'idle' || state.isSending || state.callStatus !== 'off') return;

    if (state.needsLogin) {
      showError('Masukkan password dulu di panel akses di atas.');
      ref.demo.querySelector('input')?.focus();
      return;
    }
    if (!state.deepgramKey) {
      state.deepgramFormOpen = true;
      state.deepgramFor = 'mic';
      renderDemo();
      showError('Masukkan API key Deepgram dulu di panel akses di atas untuk bertanya lewat suara.');
      ref.demo.querySelector('[data-deepgram] input')?.focus();
      return;
    }

    state.error = '';
    renderMessages();
    const connecting = new AbortController(); // dibatalkan cancelRecording kalau widget ditutup selagi menyambung
    dictation.connecting = connecting;
    setVoiceStatus('connecting');
    ref.status.textContent = 'Menyambung ke Deepgram.';
    try {
      dictation.cancelled = false;
      await startRecording(state.deepgramKey, connecting.signal);
      setVoiceStatus('recording');
      // Widget ditutup selagi menyambung: rekaman langsung dibatalkan.
      if (!state.isOpen) {
        cancelRecording();
        return;
      }
      ref.status.textContent = 'Merekam. Tekan tombol mic lagi untuk berhenti dan mengirim.';
      ref.mic.focus();
    } catch (error) {
      setVoiceStatus('idle');
      if (!state.isOpen || connecting.signal.aborted) return;
      showError(error.message);
      ref.mic.focus();
    }
  }

  /* Telepon (Tingkat 4): mendengarkan lewat WebSocket Deepgram, menjawab lewat Netra,
     lalu membacakan jawabannya dengan text to speech Deepgram. Agent belum bisa dipotong saat bicara. */

  // Panggilan c masih berjalan? Proses yang telat selesai (misalnya jawaban Netra setelah ditutup)
  // memakai ini supaya tidak mengganggu panggilan yang sudah berakhir atau panggilan baru.
  function isLive(c) {
    return c === call && state.callStatus !== 'off';
  }

  function pickRandom(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  // true kalau promise selesai (berhasil atau gagal) dalam ms milidetik, false kalau belum.
  function settlesWithin(promise, ms) {
    let timer;
    return Promise.race([
      promise.then(() => true, () => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  // Salam pembuka menyesuaikan jam di komputer penelepon, seperti CS sungguhan.
  function callGreeting(schoolName) {
    const hour = new Date().getHours();
    const time = hour < 11 ? 'pagi' : hour < 15 ? 'siang' : hour < 18 ? 'sore' : 'malam';
    return `Halo, selamat ${time}! Dengan ${AGENT_NAME}, asisten SPMB ${schoolName}. Ada yang bisa saya bantu, Kak?`;
  }

  function needsChecking(question) {
    return !SMALL_TALK.test(question.trim());
  }

  const DEEPGRAM_NETWORK_ERROR = 'Tidak bisa terhubung ke Deepgram. Periksa koneksi internet.';

  function describeSpeechError(status, data) {
    const code = data?.error?.code;
    const message = typeof data?.error?.message === 'string' ? data.error.message.slice(0, 200) : '';
    // Error dari server lokal (server.mjs), bukan dari Deepgram.
    if (code === 'SIGI_NO_KEY' || code === 'SIGI_BAD_KEY') return `${message} Perbaiki file .env (atau env di Vercel), lalu coba lagi.`;
    if (code === 'SIGI_DEEPGRAM_UNREACHABLE') return `Tidak bisa terhubung ke Deepgram (${message}). Periksa koneksi internet.`;
    if (code === 'SIGI_LOGIN') {
      useServerKeys(); // menampilkan kolom password lagi, riwayat chat tetap ada
      return data.error.message;
    }
    if (typeof code === 'string' && code.startsWith('SIGI_')) return `Server Sigi menolak permintaan: ${message}`;
    const info = `(kode ${status}${message ? `: ${message}` : ''})`;
    if (status === 401 || status === 403) return `API key Deepgram ditolak ${info}. ${code === 'DEEPGRAM' ? 'Periksa key-nya di env server.' : 'Periksa lagi API key Deepgram.'}`;
    if (status === 402) return `Saldo Deepgram habis ${info}.`;
    if (status === 429) return `Terlalu banyak permintaan ke Deepgram ${info}. Tunggu sebentar.`;
    return `Suara agent gagal dibuat ${info}.`;
  }

  // Meminta suara dari Deepgram. signal dipakai endCall untuk membatalkan unduhan yang belum selesai.
  async function requestSpeech(apiKey, text, signal, voice, expressivity) {
    let response;
    const isEmbed = apiKey === EMBED_KEY;
    const viaServer = apiKey === SERVER_KEY;
    try {
      response = await fetch(
        isEmbed ? `${embedApiBase}/api/v1/speak` : viaServer ? '/api/speak' : speakUrl(voice, expressivity),
        {
          method: 'POST',
          headers: {
            ...(isEmbed ? { 'X-Sigi-Key': embedKey } : viaServer ? {} : { Authorization: `Token ${apiKey}` }),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(isEmbed || viaServer ? { text, ...speakOptions(voice, expressivity) } : { text }),
          signal,
        },
      );
    } catch {
      throw new Error(viaServer || isEmbed ? LOCAL_SERVER_DOWN : DEEPGRAM_NETWORK_ERROR);
    }
    if (!response.ok) throw new Error(describeSpeechError(response.status, viaServer || isEmbed ? await response.json().catch(() => null) : null));
    return response;
  }

  // Object URL dicatat di call, supaya endCall bisa membersihkan yang belum sempat dilepas.
  function trackUrl(url) {
    call.urls?.add(url);
    return url;
  }

  function releaseAudio(c, audio) {
    if (audio.src.startsWith('blob:')) {
      URL.revokeObjectURL(audio.src);
      c.urls?.delete(audio.src);
    }
  }

  function audioFromBlob(blob) {
    return new Audio(trackUrl(URL.createObjectURL(blob)));
  }

  // Suara diputar sambil diunduh, supaya penelepon tidak menunggu seluruh file MP3 selesai.
  function streamAudio(response) {
    const mediaSource = new MediaSource();
    const audio = new Audio(trackUrl(URL.createObjectURL(mediaSource)));
    mediaSource.addEventListener('sourceopen', async () => {
      const reader = response.body.getReader();
      try {
        const buffer = mediaSource.addSourceBuffer('audio/mpeg');
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer.appendBuffer(value);
          // appendBuffer bekerja di latar belakang; potongan berikutnya baru boleh ditambahkan setelah selesai.
          await new Promise((resolve) => buffer.addEventListener('updateend', resolve, { once: true }));
        }
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch {
        // Unduhan putus atau panggilan diakhiri. endOfStream('network') membuat audio memicu 'error'
        // dan berhenti di tengah, jadi panggilan akan diakhiri. Tandanya dipasang dulu, supaya
        // playAudio memberi pesan soal koneksi, bukan soal pemutaran.
        reader.cancel().catch(() => {});
        audio.dataset.networkFailed = 'true';
        if (mediaSource.readyState === 'open') mediaSource.endOfStream('network');
      }
    }, { once: true });
    return audio;
  }

  async function createAgentAudio(response) {
    if (window.MediaSource && MediaSource.isTypeSupported('audio/mpeg') && response.body) {
      return streamAudio(response);
    }
    // Cadangan untuk browser tanpa MediaSource (misalnya Safari di iPhone): unduh dulu, baru diputar.
    let blob;
    try {
      blob = await response.blob();
    } catch {
      throw new Error(DEEPGRAM_NETWORK_ERROR);
    }
    return audioFromBlob(blob);
  }

  // Selesai saat audio habis diputar. Audio disimpan di call supaya endCall bisa menghentikannya.
  function playAudio(audio) {
    const c = call;
    emit('audio', { audio }); // halaman sekolah boleh ikut mendengarkan, misalnya untuk menggerakkan mulut maskot
    return new Promise((resolve, reject) => {
      c.audio = audio;
      c.finishAudio = resolve; // dipanggil endCall, karena audio yang di-pause tidak pernah 'ended'
      audio.addEventListener('ended', () => resolve(), { once: true });
      audio.addEventListener('error', () => {
        // Unduhan yang putus di tengah (lihat streamAudio) adalah masalah koneksi, bukan masalah pemutaran.
        reject(new Error(audio.dataset.networkFailed ? DEEPGRAM_NETWORK_ERROR : 'Suara agent tidak bisa diputar.'));
      }, { once: true });
      audio.play().catch((error) => {
        if (error.name === 'NotAllowedError') {
          reject(new Error('Browser menahan suara agent. Klik di mana saja di halaman, lalu tekan Telepon lagi.'));
        } else if (error.name !== 'AbortError') {
          // AbortError muncul kalau endCall mem-pause audio sebelum mulai; itu bukan error.
          reject(new Error('Suara agent tidak bisa diputar.'));
        }
      });
    }).finally(() => {
      if (c.audio === audio) {
        c.audio = null;
        c.finishAudio = null;
      }
      releaseAudio(c, audio);
    });
  }

  // Kalimat jeda diambil dari cache (sudah diunduh di awal), jawaban biasa diminta dan diputar sambil diunduh.
  async function speak(text, fromCache = false) {
    const c = call;
    let audio;
    if (fromCache) {
      const blob = c.lineAudio?.get(text);
      if (!blob) return;
      audio = audioFromBlob(blob);
    } else {
      const response = await requestSpeech(c.deepgramKey, text, c.controller?.signal, c.voice, c.expressivity);
      if (!isLive(c)) return;
      audio = await createAgentAudio(response);
    }
    if (!isLive(c)) {
      releaseAudio(c, audio);
      return;
    }
    emit('say', { text });
    setCallStatus('speaking');
    await playAudio(audio);
  }

  // Sigi bicara, lalu kembali mendengarkan. Kalau suara gagal, panggilan diakhiri dengan pesan yang jelas.
  async function agentSays(text) {
    const c = call;
    try {
      // Tanda Markdown yang lolos dari aturan telepon dibuang dulu, supaya tidak ikut dibacakan.
      await speak(stripMarkdown(text));
      if (isLive(c)) resumeListening();
    } catch (error) {
      if (isLive(c)) endCall(error.message);
    }
  }

  // Suara kalimat jeda diminta sekali di awal panggilan, supaya bisa langsung diputar saat dibutuhkan.
  // Kalau ada yang gagal, kalimat itu dilewati saja: panggilan tetap jalan tanpa kalimat jeda.
  function preloadLines(c) {
    for (const line of [...CHECKING_LINES, STILL_CHECKING_LINE]) {
      requestSpeech(c.deepgramKey, line, c.controller.signal, c.voice, c.expressivity)
        .then((response) => response.blob())
        .then((blob) => {
          if (isLive(c)) c.lineAudio.set(line, blob);
        })
        .catch(() => {});
    }
  }

  // Mengucapkan kalimat jeda dan menampilkannya sebagai gelembung jawaban. true kalau benar-benar diucapkan.
  // Entri kalimat jeda dicatat di turn, supaya answerCustomer tahu entri mana saja milik giliran ini.
  async function sayFiller(c, line, turn) {
    if (!isLive(c) || !c.lineAudio.has(line)) return false;
    const filler = { role: 'assistant', content: line };
    turn.push(filler);
    state.history.push(filler);
    renderMessages();
    await speak(line, true);
    if (isLive(c)) setCallStatus('thinking');
    return true;
  }

  // Rekaman dijeda selama Sigi berpikir dan bicara, supaya suara Sigi sendiri tidak ikut terekam.
  function pauseListening() {
    if (call.recorder?.state === 'recording') call.recorder.pause();
  }

  function resumeListening() {
    call.finalText = '';
    call.interimText = '';
    call.turnEnded = false;
    state.callHeard = '';
    if (call.recorder?.state === 'paused') call.recorder.resume();
    setCallStatus('listening');
  }

  async function answerCustomer(question) {
    const c = call;
    pauseListening();
    const before = state.history.length;
    const entry = { role: 'user', content: question };
    state.history.push(entry);
    // Semua entri giliran ini (pertanyaan, lalu kalimat jeda kalau ada), berurutan sesudah `before`.
    const turn = [entry];
    emit('question', { text: question });
    // true kalau ujung riwayat masih persis milik giliran ini (belum dimulai ulang atau ditambah panggilan lain).
    const ownsTail = () => state.history.length === before + turn.length
      && turn.every((message, i) => state.history[before + i] === message);
    state.callHeard = '';
    setCallStatus('thinking');
    renderMessages();

    // Riwayat chat ikut dikirim, ditambah aturan telepon di akhir system prompt (di mode embed, aturan telepon ditambahkan di server).
    const messages = [{ role: 'system', content: `${buildSystemPrompt()}\n\n${CALL_RULES}` }, ...state.history];
    const replyPromise = askAgent(c.netraKey, messages, buildMeta('call', 'call_voice'), { mode: 'call' });

    try {
      let waited = false;
      if (needsChecking(question) && !(await settlesWithin(replyPromise, CHECKING_DELAY_MS))) {
        waited = await sayFiller(c, pickRandom(CHECKING_LINES), turn);
        if (waited && !(await settlesWithin(replyPromise, STILL_CHECKING_DELAY_MS))) {
          await sayFiller(c, STILL_CHECKING_LINE, turn);
        }
      }
      let reply = await replyPromise;
      if (waited) reply = `${pickRandom(THANKS_FOR_WAITING_LINES)} ${reply}`;

      if (!isLive(c)) {
        // Panggilan sudah ditutup selagi menunggu: jawaban tetap ditampilkan sebagai teks, tanpa suara,
        // asalkan belum ada pesan lain sesudah pertanyaan dan kalimat jedanya.
        if (ownsTail()) {
          state.history.push({ role: 'assistant', content: reply });
          renderMessages();
        }
        return;
      }
      state.history.push({ role: 'assistant', content: reply });
      renderMessages();
      agentSays(reply);
    } catch (error) {
      if (isLive(c)) {
        // Pertanyaan dan kalimat jeda yang gagal dijawab dibuang, supaya riwayat tetap rapi.
        state.history.length = before;
        endCall(error.message);
      } else if (ownsTail()) {
        // Panggilan sudah ditutup: pertanyaan dan kalimat jedanya juga dibuang, sama seperti saat masih berjalan.
        state.history.length = before;
        renderMessages();
      }
    }
  }

  // Giliran bicara: Sigi menjawab setelah calon murid diam (UtteranceEnd) dan teksnya sudah final.
  function handleCallMessage(event) {
    if (state.callStatus !== 'listening') return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.type === 'Results') {
      state.callHeard = collectTranscript(call, data);
      // Hasil final kosong (batuk, gumaman): UtteranceEnd tadi bukan akhir pertanyaan. Kalau tidak dibatalkan,
      // potongan final pertama dari kalimat berikutnya langsung dijawab padahal orangnya masih bicara.
      if (data.is_final && !call.finalText && !call.interimText) call.turnEnded = false;
      renderCallBar();
      emit('heard', { text: state.callHeard });
    } else if (data.type === 'UtteranceEnd' && (call.finalText || call.interimText)) {
      call.turnEnded = true;
    }
    // UtteranceEnd kadang datang sebelum hasil final, jadi tunggu sampai tidak ada teks sementara.
    if (call.turnEnded && !call.interimText && call.finalText) answerCustomer(call.finalText);
  }

  // Mematikan semua benda panggilan di satu tempat. Tanpa pesan: diakhiri biasa (tombol atau widget ditutup).
  function endCall(message) {
    const c = call;
    const wasOn = state.callStatus !== 'off';
    // Status 'off' dipasang paling awal, supaya event yang dipicu pembersihan di bawah (misalnya 'close'
    // dari socket atau 'error' dari audio) tidak memanggil endCall lagi dan menimpa pesan error-nya.
    state.callStatus = 'off';
    clearInterval(c.keepAlive);
    clearInterval(c.clock);
    c.controller?.abort(); // membatalkan unduhan suara yang belum selesai
    if (c.recorder && c.recorder.state !== 'inactive') c.recorder.stop();
    c.stream?.getTracks().forEach((track) => track.stop()); // mematikan mikrofon
    if (c.socket && c.socket.readyState === WebSocket.OPEN) c.socket.close();
    if (c.audio) c.audio.pause();
    c.finishAudio?.();
    for (const url of c.urls ?? []) URL.revokeObjectURL(url);
    c.urls?.clear();
    c.lineAudio?.clear();
    Object.assign(c, { keepAlive: null, clock: null, recorder: null, stream: null, socket: null, audio: null, finishAudio: null });

    if (!wasOn) return;
    if (c.callConnected) {
      sendEvent('call_ended', { channel: 'call', metadata: { duration_seconds: state.callSeconds } });
    }
    if (KIOSK) state.conversationId = createUuid();
    state.callHeard = '';
    if (message) {
      state.error = message;
      emit('error', { message, needsKey: false });
    }
    setCallStatus('off'); // menggambar ulang: bar panggilan hilang, form chat dan tombol kembali
    renderMessages();
    ref.status.textContent = message || 'Panggilan selesai.';
    if (state.isOpen) ref.phone.focus(); // tombol Akhiri panggilan hilang, jadi fokus dipindah ke tombol Telepon
  }

  async function startCall() {
    if (state.callStatus !== 'off' || state.isSending || state.voiceStatus !== 'idle') return;
    cancelReveal();

    if (!state.apiKey) {
      if (!state.isOpen) setOpen(true); // mode kios: panel dibuka supaya password atau key bisa diisi
      showError(`Masukkan ${state.needsLogin ? 'password' : 'API key Netra'} dulu di panel akses di atas.`);
      emit('error', { message: state.error, needsKey: true });
      ref.demo.querySelector('input')?.focus();
      return;
    }
    if (!state.deepgramKey) {
      if (!state.isOpen) setOpen(true);
      emit('error', { message: 'Masukkan API key Deepgram dulu di panel akses di atas untuk menelepon.', needsKey: true });
      state.deepgramFormOpen = true;
      state.deepgramFor = 'call';
      renderDemo();
      showError('Masukkan API key Deepgram dulu di panel akses di atas untuk menelepon.');
      ref.demo.querySelector('[data-deepgram] input')?.focus();
      return;
    }

    // Key disalin ke objek call, supaya panggilan tetap memakai key yang dipakai saat mulai.
    call = {
      controller: new AbortController(), urls: new Set(), lineAudio: new Map(), finalText: '', interimText: '', turnEnded: false,
      netraKey: state.apiKey, deepgramKey: state.deepgramKey, voice: school.voice, expressivity: school.expressivity,
    };
    const c = call;
    state.error = '';
    state.callHeard = '';
    state.callSeconds = 0;
    setCallStatus('connecting');
    renderMessages();
    // Status di bar panggilan baru saja muncul bersamaan dengan isinya, jadi bisa tidak diumumkan.
    // Awal panggilan diumumkan lewat area status yang selalu ada di halaman.
    ref.status.textContent = `Menelepon ${AGENT_NAME}. Menyambung...`;
    ref.callEnd.focus(); // tombol Telepon baru saja dimatikan, jadi fokus dipindah ke bar panggilan

    try {
      const stream = await getMicrophone();
      if (!isLive(c)) {
        stream.getTracks().forEach((track) => track.stop()); // panggilan diakhiri selagi menunggu izin mic
        return;
      }
      c.stream = stream;

      let socket;
      try {
        socket = await openDeepgramSocket(c.deepgramKey, c.controller.signal);
      } catch (error) {
        stream.getTracks().forEach((track) => track.stop()); // mematikan mikrofon lagi
        throw error;
      }
      if (!isLive(c)) {
        socket.close();
        return;
      }
      c.socket = socket;
      socket.addEventListener('message', (event) => {
        if (c === call) handleCallMessage(event);
      });
      socket.addEventListener('close', () => {
        if (isLive(c)) endCall('Panggilan terputus. Periksa koneksi internet, lalu tekan Telepon lagi.');
      });

      // Satu rekaman sepanjang panggilan. Hanya dijeda dan dilanjutkan, supaya header audio
      // yang dibutuhkan Deepgram tidak terkirim ulang di tengah koneksi.
      const recorder = new MediaRecorder(stream);
      c.recorder = recorder;
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) socket.send(event.data);
      });
      recorder.start(250); // potongan audio dikirim ke Deepgram setiap 250 milidetik
      c.keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }, KEEP_ALIVE_MS);

      const startedAt = Date.now();
      c.clock = setInterval(() => {
        state.callSeconds = Math.floor((Date.now() - startedAt) / 1000);
        ref.callTime.textContent = formatDuration(state.callSeconds);
      }, 1000);

      preloadLines(c); // di latar belakang, sengaja tidak ditunggu supaya salam tidak tertunda
      c.callConnected = true;
      sendEvent('call_started', { channel: 'call' });

      // Sigi membuka percakapan lebih dulu. Selama salam dibacakan, rekaman dijeda.
      pauseListening();
      const greeting = callGreeting(school.schoolName);
      state.history.push({ role: 'assistant', content: greeting });
      renderMessages();
      agentSays(greeting);
    } catch (error) {
      if (isLive(c)) endCall(error.message);
    }
  }

  /* Event */

  ref.mic.addEventListener('click', handleMicClick);
  ref.phone.addEventListener('click', startCall);
  ref.callEnd.addEventListener('click', () => endCall());
  ref.keyToggle.addEventListener('click', () => {
    const opening = !state.keyPanelOpen;
    state.keyPanelOpen = opening;
    if (!opening) state.deepgramFormOpen = false;
    renderDemo();
    if (opening) (ref.demo.querySelector('input') ?? ref.demo.querySelector('button'))?.focus();
  });

  ref.launcher.addEventListener('click', () => setOpen(!state.isOpen));
  ref.launcherLabel.addEventListener('click', () => setOpen(true));
  ref.close.addEventListener('click', () => setOpen(false));
  ref.messages.addEventListener('scroll', updateScrollButton, { passive: true });
  ref.scrollBottom.addEventListener('click', () => {
    ref.messages.scrollTop = ref.messages.scrollHeight;
    updateScrollButton();
  });
  ref.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });

  ref.reset.addEventListener('click', () => {
    cancelReveal();
    sendEvent('conversation_reset', { channel: state.callStatus !== 'off' ? 'call' : 'chat' });
    state.conversationId = createUuid();
    state.openedTracked = false;
    state.history = [];
    state.error = '';
    renderMessages();
    ref.status.textContent = 'Percakapan dimulai ulang.';
    ref.input.focus();
  });

  ref.form.addEventListener('submit', (event) => {
    event.preventDefault();
    send(ref.input.value);
  });

  ref.input.addEventListener('keydown', (event) => {
    // isComposing dicek agar Enter saat mengetik dengan IME tidak langsung mengirim.
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(ref.input.value);
    }
  });
  ref.input.addEventListener('input', fitInput);

  // Muat ulang data sekolah: dipanggil setelah dashboard menyimpan, atau saat tab lain mengubah data.
  function refresh() {
    if (IS_EMBED) return;
    school = load();
    applySchool();
    renderMessages();
  }

  // Dipakai dashboard multi-sekolah untuk menyinkronkan pratinjau widget ke sekolah yang sedang dipilih.
  function setSchoolData(nextSchool) {
    if (!nextSchool || typeof nextSchool !== 'object') return;
    school = {
      ...defaults(),
      ...nextSchool,
      colors: { ...defaults().colors, ...(nextSchool.colors || nextSchool.theme || {}) },
    };
    applySchool();
    renderControls();
    renderMessages();
  }

  window.addEventListener('storage', (event) => {
    if (!IS_EMBED && (event.key === STORAGE_KEY || event.key === null)) refresh();
  });

  if (!IS_EMBED && hasServerBackend()) state.isCheckingServer = true;
  renderDemo();
  renderMessages();

  async function loadEmbedConfig() {
    state.isLoadingConfig = true;
    applySchool();
    renderMessages();
    try {
      const response = await fetch(`${embedApiBase}/api/v1/widget/config`, {
        headers: { 'X-Sigi-Key': embedKey },
        cache: 'no-store',
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        state.error = describeApiError(response.status, data);
        return;
      }
      school = {
        ...defaults(),
        id: data.schoolId || '',
        schoolName: data.schoolName || 'Sekolah',
        colors: { ...defaults().colors, ...(data.colors || {}) },
        greeting: data.greeting || defaults().greeting,
        suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
        voiceEnabled: Boolean(data.voiceEnabled),
        voice: data.voice || DEFAULT_VOICE,
        expressivity: cleanExpressivity(data.expressivity),
      };
      state.error = '';
    } catch {
      state.error = 'Tidak bisa memuat konfigurasi chatbot Sigi. Periksa koneksi internet.';
    } finally {
      state.isLoadingConfig = false;
      applySchool();
      renderControls();
      renderMessages();
      emit('ready', { schoolName: school.schoolName, ok: !state.error, error: state.error });
    }
  }

  async function useServerKeys() {
    if (IS_EMBED) return;
    const wasChecking = state.isCheckingServer;
    const { login, netra, deepgram } = await serverKeys();
    state.isCheckingServer = false;
    const wasLogin = state.needsLogin;
    state.needsLogin = login === true;
    if (state.needsLogin) {
      if (state.apiKey === SERVER_KEY) state.apiKey = '';
      if (state.deepgramKey === SERVER_KEY) state.deepgramKey = '';
    }
    // Key yang sudah diketik lebih dulu tidak ditimpa.
    const useNetra = netra === true && !state.apiKey;
    const useDeepgram = deepgram === true && !state.deepgramKey;
    if (!wasChecking && !useNetra && !useDeepgram && !state.needsLogin && !wasLogin) return;
    const hadFocus = ref.demo.contains(ref.demo.getRootNode().activeElement);
    if (useNetra) state.apiKey = SERVER_KEY;
    if (useDeepgram) {
      state.deepgramKey = SERVER_KEY;
      state.deepgramFormOpen = false;
    }
    if (!state.needsLogin) state.error = '';
    renderDemo();
    renderMessages();
    if (hadFocus) (ref.demo.querySelector('input') ?? ref.input).focus(); // kolom key yang sedang fokus baru saja digambar ulang
  }

  if (IS_EMBED) loadEmbedConfig();
  else useServerKeys();

  // Supaya tombol di halaman sekolah (misalnya "Tanya Asisten SPMB") dan dashboard bisa memakai widget.
  window.SigiWidget = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    ask: (question) => {
      if (state.callStatus !== 'off') return; // pertanyaan dari halaman diabaikan selama telepon
      setOpen(true);
      send(question);
    },
    // Untuk tombol "Telepon Sigi" di halaman sekolah: membuka widget lalu langsung menelepon.
    // { open: false } dipakai halaman kios: telepon berjalan tanpa membuka panel widget.
    call: ({ open = true } = {}) => {
      if (IS_EMBED && !school.voiceEnabled) return;
      if (open) setOpen(true);
      startCall();
    },
    hangUp: () => endCall(),
    refresh,
    setSchoolData,
    // Dipakai dashboard untuk membaca dan menyimpan data sekolah.
    data: { key: STORAGE_KEY, voices: VOICES, expressivities: EXPRESSIVITY, defaults, load, save, reset, compileContext, systemPrompt: buildSystemPrompt, maxContextChars: MAX_CONTEXT_CHARS },
  };
  window.AsistenSPMBWidget = window.SigiWidget; // nama lama, tetap bisa dipakai
})();
