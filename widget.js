/*
 * Widget Sigi (versi demo)
 *
 * Cara pasang di website sekolah, cukup dua baris sebelum </body>:
 *   <script src="sekolah/wikrama.js"></script>  -> nama, warna, dan info sekolah
 *   <script src="widget.js" defer></script>     -> tombol chat di pojok kanan bawah
 *
 * Catatan demo: API key Netra (jawaban) dan Deepgram (input suara) diketik di dalam widget dan hanya
 * disimpan di memori tab ini. Untuk dipakai pengunjung sungguhan, kedua key harus dipindah ke server.
 */
(() => {
  'use strict';

  // window.Sigi: data sekolah. Nama lama window.AsistenSPMB tetap diterima supaya pemasangan lama tidak rusak.
  const config = window.Sigi || window.AsistenSPMB;
  if (!config || !(config.pages || config.context)) {
    console.warn('Sigi: data sekolah belum dimuat. Pasang file sekolah/*.js sebelum widget.js.');
    return;
  }

  const API_URL = 'https://api.netra.sh/v1/chat/completions';
  const MODEL = config.model || 'deepseek/deepseek-v4.1-flash';
  const MAX_CONTEXT_CHARS = 60000;

  // Input suara: speech to text langsung lewat WebSocket Deepgram, pengaturannya sama dengan playground (Tingkat 3).
  // nova-3, Bahasa Indonesia, tanda baca otomatis, teks sementara, dan kalimat ditutup setelah diam 0,5 detik.
  const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen?model=nova-3&language=id&smart_format=true&interim_results=true&endpointing=500&utterance_end_ms=1000';
  const MAX_RECORDING_SECONDS = 60; // rekaman berhenti sendiri, supaya mikrofon tidak lupa dimatikan

  /* Telepon (Tingkat 4): calon murid bicara, Sigi menjawab dengan suara, lalu kembali mendengarkan. */

  const AGENT_NAME = 'Sigi';
  // Text to speech Deepgram, suara Fitri (Bahasa Indonesia). Model Flux hanya tersedia di /v2/speak.
  const DEEPGRAM_SPEAK_URL = 'https://api.deepgram.com/v2/speak?model=flux-fitri-id&encoding=mp3';
  // Deepgram menutup koneksi yang 10 detik tidak menerima apa pun. Saat rekaman dijeda (Sigi berpikir
  // atau bicara), tidak ada audio yang terkirim, jadi kita kirim KeepAlive lebih sering dari itu.
  const KEEP_ALIVE_MS = 5000;

  // Ditambahkan di akhir system prompt hanya untuk telepon. Aturan terakhir sengaja mengalahkan
  // aturan Markdown di system prompt chat, karena tanda bintang dan tautan ikut dibacakan oleh suara.
  const CALL_RULES = [
    `Namamu ${AGENT_NAME}.`,
    'Calon murid atau orang tua sedang menelepon, jadi jawabanmu akan dibacakan dengan suara.',
    'Pakai bahasa lisan sehari-hari yang tetap sopan, misalnya "oke", "nah", atau "ya".',
    'Jawab paling banyak tiga kalimat pendek dan langsung ke intinya.',
    'Jangan membuka jawaban dengan sapaan atau ucapan terima kasih sudah menunggu, karena aplikasi sudah mengucapkannya.',
    'Tulis angka, jam, tanggal, dan biaya dengan huruf, misalnya sembilan juta lima ratus ribu rupiah atau pukul delapan pagi.',
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

  const STORAGE_KEY = `sigi:sekolah:${config.id || 'default'}`;

  function defaults() {
    const pages = config.pages
      ? config.pages.map((page, i) => ({ id: `p${i + 1}`, title: page.title, body: page.body.trim(), updatedAt: null }))
      : [{ id: 'p1', title: 'Info sekolah', body: config.context.trim(), updatedAt: null }];
    const schoolName = config.schoolName || 'Sekolah';
    return {
      schoolName,
      colors: { primary: '#0f766e', onPrimary: '#ffffff', accent: '#bef264', onAccent: '#0b1f1d', ...config.colors },
      greeting: config.greeting || `Halo! Aku Asisten SPMB ${schoolName}. Ada yang bisa dibantu?`,
      suggestions: config.suggestions || [],
      pages,
      documents: [], // { id, name, size, pages, text, addedAt }
      updatedAt: null,
    };
  }

  function load() {
    const base = defaults();
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

  // Semua data widget ada di sini. Tampilan selalu digambar ulang dari state ini.
  const state = {
    isOpen: false,
    apiKey: '', // hanya di memori, hilang saat tab ditutup atau dimuat ulang
    deepgramKey: '', // untuk tombol mic, juga hanya di memori
    deepgramFormOpen: false, // kolom key Deepgram baru ditampilkan saat dibutuhkan
    deepgramFor: 'mic', // 'mic' | 'call': tombol mana yang meminta key Deepgram, untuk tujuan fokus setelah disimpan
    history: [], // { role: 'user' | 'assistant', content }
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

  function describeApiError(status, data) {
    const detail = data?.error?.message;
    if (status === 401 || status === 403) return 'API key ditolak. Periksa lagi API key-nya.';
    if (status === 402) return 'Saldo atau kuota API habis.';
    if (status === 429) return 'Terlalu banyak permintaan. Tunggu sebentar, lalu kirim lagi.';
    if (status >= 500) return 'Server Netra sedang bermasalah. Coba lagi beberapa saat lagi.';
    return `Permintaan gagal (kode ${status})${detail ? `: ${detail}` : '.'}`;
  }

  async function askAgent(apiKey, messages) {
    let response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          // Token penalaran ikut dihitung di max_tokens, jadi batasnya dibuat cukup longgar.
          max_tokens: 2048,
          reasoning: { enabled: true },
        }),
      });
    } catch {
      throw new Error('Tidak bisa terhubung ke server Netra. Periksa koneksi internet.');
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(describeApiError(response.status, data));

    const reply = data?.choices?.[0]?.message?.content?.trim();
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
    mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M5 11.5a7 7 0 0 0 14 0M12 18.5V22M8 22h8"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    phoneOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/><path d="M22 2 2 22"/></svg>',
  };

  const STYLE = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    p { margin: 0; }
    .root {
      /* --primary, --on-primary, --accent, --on-accent diisi dari data sekolah oleh applySchool(). */
      font-family: "Plus Jakarta Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 14px; line-height: 1.5; color: #0f172a;
      -webkit-font-smoothing: antialiased;
    }
    button, input, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button:disabled { cursor: not-allowed; }
    :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

    .launcher { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; align-items: center; gap: 12px; }
    .launcher-label { background: #fff; border: 1px solid #e2e8f0; border-radius: 999px; padding: 10px 16px; font-weight: 600; font-size: 13px; box-shadow: 0 8px 24px rgb(15 23 42 / 0.14); }
    .launcher-btn { width: 60px; height: 60px; border: 0; border-radius: 999px; background: var(--primary); color: var(--accent); display: grid; place-items: center; box-shadow: 0 12px 30px rgb(15 23 42 / 0.28); transition: transform 0.15s ease; }
    .launcher-btn:hover { transform: scale(1.05); }
    .launcher-btn svg { width: 26px; height: 26px; }
    .launcher-btn .icon-close { display: none; }
    .root[data-open="true"] .launcher-label { display: none; }
    .root[data-open="true"] .launcher-btn .icon-chat { display: none; }
    .root[data-open="true"] .launcher-btn .icon-close { display: block; }

    .panel { position: fixed; right: 20px; bottom: 92px; z-index: 2147483000; width: 384px; max-width: calc(100vw - 40px); height: min(640px, calc(100vh - 120px)); display: flex; flex-direction: column; overflow: hidden; background: #fff; border: 1px solid #e2e8f0; border-radius: 20px; box-shadow: 0 24px 60px rgb(15 23 42 / 0.28); }
    .panel[hidden] { display: none; }

    .header { display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 16px; background: var(--primary); color: var(--on-primary); }
    .avatar { width: 40px; height: 40px; flex-shrink: 0; display: grid; place-items: center; border-radius: 999px; background: var(--accent); color: var(--on-accent); }
    .avatar svg { width: 20px; height: 20px; }
    .header-text { flex: 1; min-width: 0; }
    .title { font-size: 15px; font-weight: 700; }
    .subtitle { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.85; }
    .subtitle span:last-child { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .icon-btn { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; border: 0; border-radius: 10px; background: transparent; color: inherit; }
    /* Di header berlatar warna sekolah, cincin fokus warna sekolah tidak terlihat, jadi pakai warna teks header. */
    .header :focus-visible { outline-color: var(--on-primary); }
    .icon-btn:hover { background: rgb(255 255 255 / 0.14); }
    .icon-btn:disabled { opacity: 0.4; background: transparent; }
    .icon-btn svg { width: 18px; height: 18px; }

    .demo { padding: 10px 14px; background: #fffbeb; border-bottom: 1px solid #fde68a; color: #78350f; font-size: 12px; }
    .demo form { display: flex; gap: 8px; margin-top: 8px; }
    .demo input { flex: 1; min-width: 0; height: 44px; padding: 0 10px; border: 1px solid #fcd34d; border-radius: 10px; background: #fff; font-size: 13px; }
    .demo input:focus { outline: 2px solid #b45309; outline-offset: 0; }
    .demo button[type="submit"] { height: 44px; padding: 0 14px; border: 0; border-radius: 10px; background: #78350f; color: #fff; font-size: 13px; font-weight: 600; }
    .demo-ready { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .demo-ready + .demo-ready, .demo-ready + p, .demo form + p { margin-top: 6px; }
    .link-btn { min-height: 32px; padding: 4px; border: 0; background: none; color: #78350f; font-size: 12px; font-weight: 700; text-decoration: underline; }

    .messages { flex: 1; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; padding: 16px; background: #f8fafc; }
    .row { display: flex; align-items: flex-end; gap: 8px; }
    .row.user { justify-content: flex-end; }
    .mini-avatar { width: 28px; height: 28px; flex-shrink: 0; display: grid; place-items: center; border-radius: 999px; background: var(--primary); color: var(--accent); }
    .mini-avatar svg { width: 15px; height: 15px; }
    .bubble { position: relative; max-width: 82%; padding: 10px 14px; border-radius: 18px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .row.user .bubble { border-bottom-right-radius: 6px; background: var(--primary); color: var(--on-primary); }
    .row.bot .bubble { border: 1px solid #e2e8f0; border-bottom-left-radius: 6px; background: #fff; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; padding-left: 36px; }
    .chip { min-height: 44px; padding: 6px 14px; border: 1px solid var(--primary); border-radius: 999px; background: #fff; color: var(--primary); font-size: 13px; font-weight: 600; }
    .chip:hover { background: color-mix(in srgb, var(--primary) 8%, #fff); }
    .typing { display: inline-flex; align-items: center; gap: 4px; height: 21px; }
    .typing span { width: 6px; height: 6px; border-radius: 999px; background: #94a3b8; animation: asisten-bounce 1s infinite ease-in-out; }
    .typing span:nth-child(2) { animation-delay: 0.15s; }
    .typing span:nth-child(3) { animation-delay: 0.3s; }
    @keyframes asisten-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.5; } 40% { transform: translateY(-4px); opacity: 1; } }
    .md { white-space: normal; }
    .md > * + * { margin-top: 8px; }
    .md ul, .md ol { margin: 0; padding-left: 20px; }
    .md li + li, .md li > ul, .md li > ol { margin-top: 4px; }
    .md strong, .md .md-heading { font-weight: 700; }
    .md code { padding: 1px 5px; border-radius: 6px; background: #f1f5f9; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
    .md a { color: var(--primary); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
    .error { padding: 10px 12px; border: 1px solid #fecaca; border-radius: 14px; background: #fef2f2; color: #991b1b; font-size: 13px; }

    .composer { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid #e2e8f0; background: #fff; }
    .composer textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 120px; padding: 11px 12px; border: 1px solid #cbd5e1; border-radius: 14px; background: #fff; line-height: 1.4; resize: none; }
    .composer textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent); }
    .mic { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; border: 1px solid #cbd5e1; border-radius: 14px; background: #fff; color: var(--primary); }
    .mic:hover { background: #f8fafc; }
    .mic svg { width: 20px; height: 20px; }
    .mic .icon-stop { display: none; }
    /* Selama merekam: tombol memakai warna utama sekolah, dan ikon mic diganti ikon kotak (berhenti). */
    .mic[data-recording="true"] { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
    .mic[data-recording="true"] .icon-mic { display: none; }
    .mic[data-recording="true"] .icon-stop { display: block; }
    .mic:disabled { border-color: #e2e8f0; background: #f1f5f9; color: #94a3b8; }
    .voice-status { padding: 8px 14px 0; background: #fff; color: #334155; font-size: 12px; font-weight: 600; }
    .voice-status[hidden] { display: none; }
    .send { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; border: 0; border-radius: 14px; background: var(--accent); color: var(--on-accent); }
    .send svg { width: 18px; height: 18px; }
    .send:disabled { background: #e2e8f0; color: #94a3b8; }
    /* Atribut hidden kalah oleh display: flex, jadi perlu ditegaskan. */
    .composer[hidden], .call-bar[hidden], .call-heard[hidden] { display: none; }

    /* Bar panggilan: menggantikan form pertanyaan selama telepon berjalan. Sengaja tanpa animasi. */
    .call-bar { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-top: 1px solid #e2e8f0; background: #fff; }
    .call-row { display: flex; align-items: center; gap: 10px; }
    .call-info { flex: 1; min-width: 0; }
    .call-state { color: #0f172a; font-size: 13px; font-weight: 700; line-height: 1.35; }
    .call-time { color: #475569; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .call-heard { max-height: 66px; overflow-y: auto; padding: 8px 12px; border-radius: 12px; background: color-mix(in srgb, var(--primary) 8%, #fff); color: #0f172a; font-size: 13px; overflow-wrap: anywhere; }
    /* Merah tua di atas putih: kontras sekitar 6,5:1, jadi tetap terbaca walau warna sekolah apa pun. */
    .call-end { min-height: 44px; flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 14px; border: 0; border-radius: 999px; background: #b91c1c; color: #fff; font-size: 13px; font-weight: 700; }
    .call-end:hover { background: #991b1b; }
    .call-end svg { width: 18px; height: 18px; flex-shrink: 0; }
    .call-note { color: #64748b; font-size: 11px; }
    .footer { padding: 0 12px 10px; background: #fff; color: #64748b; font-size: 11px; text-align: center; }
    .footer a { color: inherit; font-weight: 700; }

    @media (max-width: 480px) {
      .panel { inset: 0; width: auto; max-width: none; height: auto; border: 0; border-radius: 0; }
      .root[data-open="true"] .launcher { display: none; }
      .launcher-label { display: none; }
      /* iPhone otomatis nge-zoom kalau huruf di kolom isian di bawah 16px. */
      .composer textarea, .demo input { font-size: 16px; }
    }
  `;

  // Kerangka statis widget. Tidak ada data dari pengguna atau AI di sini, jadi aman memakai innerHTML.
  // Semua teks yang berubah-ubah (nama sekolah, pesan, error) dimasukkan lewat textContent.
  const MARKUP = `
    <div class="root" data-open="false">
      <div class="launcher">
        <span class="launcher-label" aria-hidden="true">Tanya soal SPMB?</span>
        <button class="launcher-btn" type="button" aria-expanded="false" aria-controls="asisten-panel" aria-label="Buka Asisten SPMB" data-ref="launcher">
          <span class="icon-chat">${ICONS.chat}</span><span class="icon-close">${ICONS.close}</span>
        </button>
      </div>
      <section class="panel" id="asisten-panel" role="dialog" aria-labelledby="asisten-title" hidden data-ref="panel">
        <header class="header">
          <span class="avatar">${ICONS.bot}</span>
          <div class="header-text">
            <p class="title" id="asisten-title">Asisten SPMB</p>
            <p class="subtitle"><span data-ref="school"></span></p>
          </div>
          <button class="icon-btn" type="button" aria-label="Telepon Sigi" title="Telepon Sigi" data-ref="phone">${ICONS.phone}</button>
          <button class="icon-btn" type="button" aria-label="Mulai percakapan baru" title="Mulai percakapan baru" data-ref="reset">${ICONS.reset}</button>
          <button class="icon-btn" type="button" aria-label="Tutup Asisten SPMB" title="Tutup" data-ref="close">${ICONS.close}</button>
        </header>
        <div class="demo" data-ref="demo"></div>
        <div class="messages" data-ref="messages"></div>
        <p class="sr-only" role="status" aria-live="polite" data-ref="status"></p>
        <p class="voice-status" data-ref="voiceStatus" hidden></p>
        <form class="composer" data-ref="form">
          <label class="sr-only" for="asisten-input">Tulis pertanyaan</label>
          <textarea id="asisten-input" rows="1" placeholder="Tulis pertanyaan..." data-ref="input"></textarea>
          <!-- type="button": tanpa ini, tombol di dalam form dianggap tombol kirim. -->
          <button class="mic" type="button" aria-label="Rekam suara" data-ref="mic"><span class="icon-mic">${ICONS.mic}</span><span class="icon-stop">${ICONS.stop}</span></button>
          <button class="send" type="submit" aria-label="Kirim pertanyaan" data-ref="send">${ICONS.send}</button>
        </form>
        <div class="call-bar" data-ref="callBar" hidden>
          <div class="call-row">
            <div class="call-info">
              <!-- Hanya status yang diumumkan pembaca layar. Lama panggilan dan teks yang terdengar
                   sengaja di luar area ini, supaya tidak dibacakan setiap detik. -->
              <p class="call-state" role="status" aria-live="polite" data-ref="callState"></p>
              <p class="call-time"><span class="sr-only">Lama panggilan </span><span data-ref="callTime">0:00</span></p>
            </div>
            <button class="call-end" type="button" data-ref="callEnd">${ICONS.phoneOff}<span>Akhiri panggilan</span></button>
          </div>
          <p class="call-heard" data-ref="callHeard" hidden></p>
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
  document.body.append(host);

  const root = shadow.querySelector('.root');
  const ref = {};
  for (const node of shadow.querySelectorAll('[data-ref]')) ref[node.dataset.ref] = node;

  ref.powered.href = config.poweredByUrl || 'index.html';

  // Nama dan warna sekolah dipasang ulang setiap kali data berubah (misalnya setelah disimpan di dashboard).
  function applySchool() {
    root.style.setProperty('--primary', school.colors.primary);
    root.style.setProperty('--on-primary', school.colors.onPrimary);
    root.style.setProperty('--accent', school.colors.accent);
    root.style.setProperty('--on-accent', school.colors.onAccent);
    ref.school.textContent = school.schoolName;
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

  function miniAvatar() {
    const avatar = make('span', 'mini-avatar');
    avatar.innerHTML = ICONS.bot; // ikon statis, bukan teks dari AI
    return avatar;
  }

  function messageRow(role, text) {
    const isUser = role === 'user';
    const row = make('div', `row ${isUser ? 'user' : 'bot'}`);
    const bubble = make('div', 'bubble');
    // Label untuk pembaca layar, lalu isinya. Pesan pengguna tetap teks biasa (text node);
    // jawaban asisten ditampilkan sebagai Markdown sederhana lewat renderMarkdown (juga tanpa innerHTML).
    bubble.append(make('span', 'sr-only', isUser ? 'Kamu: ' : 'Asisten: '));
    if (isUser) {
      bubble.append(document.createTextNode(text));
    } else {
      const body = make('div', 'md');
      body.append(renderMarkdown(text));
      bubble.append(body);
    }
    if (!isUser) row.append(miniAvatar());
    row.append(bubble);
    return row;
  }

  function typingRow() {
    const row = make('div', 'row bot');
    const bubble = make('div', 'bubble');
    const dots = make('span', 'typing');
    dots.append(make('span'), make('span'), make('span'));
    bubble.append(make('span', 'sr-only', 'Asisten sedang menulis jawaban'), dots);
    row.append(miniAvatar(), bubble);
    return row;
  }

  /* Tampilan */

  // Kolom API key di kotak kuning mode demo. Dipakai untuk key Netra dan key Deepgram.
  function keyForm(placeholder, label, onSave) {
    const form = make('form');
    const input = make('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = placeholder;
    input.setAttribute('aria-label', label);
    const save = make('button', '', 'Pakai');
    save.type = 'submit';
    form.append(input, save);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const key = input.value.trim();
      if (!key) {
        input.focus();
        return;
      }
      onSave(key);
    });
    return form;
  }

  function readyRow(text, buttonText, onClick) {
    const row = make('div', 'demo-ready');
    row.append(make('span', '', text));
    // Selama telepon, key tidak boleh diganti: tombolnya tidak ditampilkan sama sekali, supaya
    // key yang sedang dipakai panggilan tidak dikosongkan dan fokus tidak lompat ke kotak kuning.
    if (state.callStatus === 'off') {
      const button = make('button', 'link-btn', buttonText);
      button.type = 'button';
      button.addEventListener('click', onClick);
      row.append(button);
    }
    return row;
  }

  function renderDemo() {
    ref.demo.replaceChildren();

    // Key Netra: untuk jawaban asisten.
    if (state.apiKey) {
      ref.demo.append(readyRow('Mode demo · API key aktif di tab ini', 'Ganti key', () => {
        state.apiKey = '';
        renderDemo();
        ref.demo.querySelector('input').focus();
      }));
    } else {
      ref.demo.append(
        make('p', '', 'Mode demo: masukkan API key Netra untuk mencoba. Key hanya disimpan di tab ini.'),
        keyForm('Tempel API key Netra', 'API key Netra untuk mode demo', (key) => {
          state.apiKey = key;
          state.error = '';
          renderDemo();
          renderMessages();
          ref.input.focus();
        }),
      );
    }

    // Key Deepgram: untuk tombol mic dan Telepon. Kolomnya baru muncul saat dibutuhkan, supaya kotak ini tetap pendek.
    if (state.deepgramKey) {
      ref.demo.append(readyRow('Suara aktif · key Deepgram di tab ini', 'Ganti key Deepgram', () => {
        state.deepgramKey = '';
        state.deepgramFormOpen = true;
        state.deepgramFor = 'mic';
        renderDemo();
        ref.demo.querySelector('[data-deepgram] input').focus();
      }));
    } else if (state.deepgramFormOpen) {
      const form = keyForm('Tempel API key Deepgram', 'API key Deepgram untuk mic dan telepon', (key) => {
        state.deepgramKey = key;
        state.deepgramFormOpen = false;
        state.error = '';
        renderDemo();
        renderMessages();
        // Fokus kembali ke tombol yang tadi meminta key, supaya bisa langsung dicoba lagi.
        (state.deepgramFor === 'call' ? ref.phone : ref.mic).focus();
      });
      form.dataset.deepgram = '';
      ref.demo.append(make('p', '', 'Untuk mic dan telepon, masukkan API key Deepgram. Key juga hanya disimpan di tab ini.'), form);
    } else if (state.apiKey) {
      ref.demo.append(readyRow('Mau bertanya lewat suara?', 'Pakai mic', () => {
        state.deepgramFormOpen = true;
        state.deepgramFor = 'mic';
        renderDemo();
        ref.demo.querySelector('[data-deepgram] input').focus();
      }));
    }
  }

  function renderMessages() {
    ref.messages.replaceChildren(messageRow('assistant', school.greeting));

    const suggestions = school.suggestions.filter((question) => question.trim());
    // Selama telepon, saran pertanyaan disembunyikan karena chat diketik sedang tidak bisa dipakai.
    if (state.history.length === 0 && suggestions.length > 0 && state.callStatus === 'off') {
      const chips = make('div', 'chips');
      for (const question of suggestions) {
        const chip = make('button', 'chip', question);
        chip.type = 'button';
        chip.addEventListener('click', () => send(question));
        chips.append(chip);
      }
      ref.messages.append(chips);
    }

    for (const message of state.history) {
      ref.messages.append(messageRow(message.role, message.content));
    }
    if (state.isSending) ref.messages.append(typingRow());
    if (state.error) ref.messages.append(make('p', 'error', state.error));

    renderControls();
    requestAnimationFrame(() => {
      ref.messages.scrollTop = ref.messages.scrollHeight;
    });
  }

  function fitInput() {
    ref.input.style.height = 'auto';
    ref.input.style.height = `${Math.min(ref.input.scrollHeight + 2, 120)}px`;
  }

  function setOpen(isOpen) {
    state.isOpen = isOpen;
    root.dataset.open = String(isOpen);
    ref.panel.hidden = !isOpen;
    ref.launcher.setAttribute('aria-expanded', String(isOpen));
    ref.launcher.setAttribute('aria-label', isOpen ? 'Tutup Asisten SPMB' : 'Buka Asisten SPMB');
    if (isOpen) {
      renderMessages();
      // Selama telepon, kolom pertanyaan disembunyikan, jadi fokus ke tombol Akhiri panggilan.
      if (state.callStatus !== 'off') ref.callEnd.focus();
      else (state.apiKey ? ref.input : ref.demo.querySelector('input')).focus();
    } else {
      // Widget ditutup saat merekam: mikrofon langsung dimatikan, tanpa mengirim apa pun.
      if (state.voiceStatus !== 'idle') cancelRecording();
      // Widget ditutup saat menelepon: panggilan diakhiri biasa, bukan dianggap error.
      if (state.callStatus !== 'off') endCall();
      ref.launcher.focus();
    }
  }

  /* Mengirim pertanyaan */

  async function send(rawQuestion) {
    const question = rawQuestion.trim();
    // Selama telepon, pertanyaan diketik diabaikan: riwayat sedang dipakai oleh panggilan.
    if (!question || state.isSending || state.voiceStatus !== 'idle' || state.callStatus !== 'off') return;

    if (!state.apiKey) {
      ref.input.value = question;
      fitInput();
      state.error = 'Masukkan API key Netra dulu di kotak kuning di atas.';
      renderMessages();
      ref.demo.querySelector('input').focus();
      return;
    }

    state.error = '';
    state.history.push({ role: 'user', content: question });
    ref.input.value = '';
    fitInput();
    state.isSending = true;
    renderMessages();
    ref.status.textContent = 'Asisten sedang menulis jawaban.';

    // Riwayat chat ikut dikirim setiap kali, karena API tidak mengingat percakapan sebelumnya.
    const messages = [{ role: 'system', content: buildSystemPrompt() }, ...state.history];

    try {
      const reply = await askAgent(state.apiKey, messages);
      state.history.push({ role: 'assistant', content: reply });
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
      renderMessages();
    }
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
    ref.mic.dataset.recording = String(voice === 'recording');
    ref.mic.setAttribute('aria-label', VOICE[voice].label);
    ref.mic.title = VOICE[voice].label;
    // Selama telepon, semua tombol chat dimatikan supaya riwayat tidak diubah dari dua jalur sekaligus.
    ref.mic.disabled = inCall || state.isSending || voice === 'connecting' || voice === 'transcribing';
    ref.send.disabled = inCall || state.isSending || busy;
    ref.reset.disabled = inCall || state.history.length === 0 || state.isSending || busy;
    ref.phone.disabled = inCall || state.isSending || busy;
    ref.phone.setAttribute('aria-label', CALL[state.callStatus].label);
    ref.phone.title = CALL[state.callStatus].label;
    // Kolom pertanyaan dikunci selama merekam, supaya ketikan tidak tertimpa teks dari Deepgram.
    ref.input.readOnly = busy;
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

  function openDeepgramSocket(apiKey) {
    return new Promise((resolve, reject) => {
      // Browser tidak bisa menambah header Authorization ke WebSocket, jadi API key dikirim lewat subprotocol.
      const socket = new WebSocket(DEEPGRAM_LIVE_URL, ['token', apiKey]);
      socket.addEventListener('open', () => resolve(socket));
      socket.addEventListener('error', () => {
        reject(new Error('Gagal tersambung ke Deepgram. Periksa API key Deepgram dan koneksi internet.'));
      });
    });
  }

  async function startRecording(apiKey) {
    const stream = await getMicrophone();
    let socket;
    try {
      socket = await openDeepgramSocket(apiKey);
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop()); // mematikan mikrofon lagi
      throw error;
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
      send(ref.input.value);
    }
  }

  async function handleMicClick() {
    if (state.voiceStatus === 'recording') {
      stopRecording();
      return;
    }
    if (state.voiceStatus !== 'idle' || state.isSending || state.callStatus !== 'off') return;

    if (!state.deepgramKey) {
      state.deepgramFormOpen = true;
      state.deepgramFor = 'mic';
      renderDemo();
      showError('Masukkan API key Deepgram dulu di kotak kuning di atas untuk bertanya lewat suara.');
      ref.demo.querySelector('[data-deepgram] input').focus();
      return;
    }

    state.error = '';
    renderMessages();
    setVoiceStatus('connecting');
    ref.status.textContent = 'Menyambung ke Deepgram.';
    try {
      dictation.cancelled = false;
      await startRecording(state.deepgramKey);
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
      if (!state.isOpen) return;
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

  function describeSpeechError(status) {
    if (status === 401 || status === 403) return 'API key Deepgram ditolak. Periksa lagi API key Deepgram.';
    if (status === 402) return 'Saldo Deepgram habis.';
    if (status === 429) return 'Terlalu banyak permintaan ke Deepgram. Tunggu sebentar.';
    return `Suara agent gagal dibuat (kode ${status}).`;
  }

  // Meminta suara dari Deepgram. signal dipakai endCall untuk membatalkan unduhan yang belum selesai.
  async function requestSpeech(apiKey, text, signal) {
    let response;
    try {
      response = await fetch(DEEPGRAM_SPEAK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
        signal,
      });
    } catch {
      throw new Error(DEEPGRAM_NETWORK_ERROR);
    }
    if (!response.ok) throw new Error(describeSpeechError(response.status));
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
      const response = await requestSpeech(c.deepgramKey, text, c.controller?.signal);
      if (!isLive(c)) return;
      audio = await createAgentAudio(response);
    }
    if (!isLive(c)) {
      releaseAudio(c, audio);
      return;
    }
    setCallStatus('speaking');
    await playAudio(audio);
  }

  // Sigi bicara, lalu kembali mendengarkan. Kalau suara gagal, panggilan diakhiri dengan pesan yang jelas.
  async function agentSays(text) {
    const c = call;
    try {
      await speak(text);
      if (isLive(c)) resumeListening();
    } catch (error) {
      if (isLive(c)) endCall(error.message);
    }
  }

  // Suara kalimat jeda diminta sekali di awal panggilan, supaya bisa langsung diputar saat dibutuhkan.
  // Kalau ada yang gagal, kalimat itu dilewati saja: panggilan tetap jalan tanpa kalimat jeda.
  function preloadLines(c) {
    for (const line of [...CHECKING_LINES, STILL_CHECKING_LINE]) {
      requestSpeech(c.deepgramKey, line, c.controller.signal)
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
    // true kalau ujung riwayat masih persis milik giliran ini (belum dimulai ulang atau ditambah panggilan lain).
    const ownsTail = () => state.history.length === before + turn.length
      && turn.every((message, i) => state.history[before + i] === message);
    state.callHeard = '';
    setCallStatus('thinking');
    renderMessages();

    // Riwayat chat ikut dikirim, ditambah aturan telepon di akhir system prompt.
    const messages = [{ role: 'system', content: `${buildSystemPrompt()}\n\n${CALL_RULES}` }, ...state.history];
    const replyPromise = askAgent(c.netraKey, messages);

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
    state.callHeard = '';
    if (message) state.error = message;
    setCallStatus('off'); // menggambar ulang: bar panggilan hilang, form chat dan tombol kembali
    renderMessages();
    ref.status.textContent = message || 'Panggilan selesai.';
    if (state.isOpen) ref.phone.focus(); // tombol Akhiri panggilan hilang, jadi fokus dipindah ke tombol Telepon
  }

  async function startCall() {
    if (state.callStatus !== 'off' || state.isSending || state.voiceStatus !== 'idle') return;

    if (!state.apiKey) {
      showError('Masukkan API key Netra dulu di kotak kuning di atas.');
      ref.demo.querySelector('input').focus();
      return;
    }
    if (!state.deepgramKey) {
      state.deepgramFormOpen = true;
      state.deepgramFor = 'call';
      renderDemo();
      showError('Masukkan API key Deepgram dulu di kotak kuning di atas untuk menelepon.');
      ref.demo.querySelector('[data-deepgram] input').focus();
      return;
    }

    // Key disalin ke objek call, supaya panggilan tetap memakai key yang dipakai saat mulai.
    call = {
      controller: new AbortController(), urls: new Set(), lineAudio: new Map(), finalText: '', interimText: '', turnEnded: false,
      netraKey: state.apiKey, deepgramKey: state.deepgramKey,
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
        socket = await openDeepgramSocket(c.deepgramKey);
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

  ref.launcher.addEventListener('click', () => setOpen(!state.isOpen));
  ref.close.addEventListener('click', () => setOpen(false));
  ref.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });

  ref.reset.addEventListener('click', () => {
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
    school = load();
    applySchool();
    renderMessages();
  }

  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) refresh();
  });

  renderDemo();
  renderMessages();

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
    call: () => {
      setOpen(true);
      startCall();
    },
    refresh,
    // Dipakai dashboard untuk membaca dan menyimpan data sekolah.
    data: { key: STORAGE_KEY, defaults, load, save, reset, compileContext, systemPrompt: buildSystemPrompt, maxContextChars: MAX_CONTEXT_CHARS },
  };
  window.AsistenSPMBWidget = window.SigiWidget; // nama lama, tetap bisa dipakai
})();
