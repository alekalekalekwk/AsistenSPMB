/*
 * Widget AsistenSPMB (versi demo)
 *
 * Cara pasang di website sekolah, cukup dua baris sebelum </body>:
 *   <script src="sekolah/wikrama.js"></script>  -> nama, warna, dan info sekolah
 *   <script src="widget.js" defer></script>     -> tombol chat di pojok kanan bawah
 *
 * Catatan demo: API key Netra diketik di dalam widget dan hanya disimpan di memori tab ini.
 * Untuk dipakai pengunjung sungguhan, key harus dipindah ke server.
 */
(() => {
  'use strict';

  const config = window.AsistenSPMB;
  if (!config || !(config.pages || config.context)) {
    console.warn('AsistenSPMB: data sekolah belum dimuat. Pasang file sekolah/*.js sebelum widget.js.');
    return;
  }

  const API_URL = 'https://api.netra.sh/v1/chat/completions';
  const MODEL = config.model || 'deepseek/deepseek-v4.1-flash';
  const MAX_CONTEXT_CHARS = 60000;

  /* Data sekolah. Bawaannya dari sekolah/*.js; kalau sekolah sudah mengedit lewat dashboard,
     versi dashboard (disimpan di localStorage browser ini, mode demo) yang dipakai. */

  const STORAGE_KEY = `asistenspmb:sekolah:${config.id || 'default'}`;

  function defaults() {
    const pages = config.pages
      ? config.pages.map((page, i) => ({ id: `p${i + 1}`, icon: page.icon || '📄', title: page.title, body: page.body.trim(), updatedAt: null }))
      : [{ id: 'p1', icon: '📄', title: 'Info sekolah', body: config.context.trim(), updatedAt: null }];
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
    history: [], // { role: 'user' | 'assistant', content }
    isSending: false,
    error: '',
  };

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
      'Tulis jawaban sebagai teks biasa tanpa format Markdown.',
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

  if (!document.querySelector('link[data-asisten-spmb-font]')) {
    const font = document.createElement('link');
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap';
    font.dataset.asistenSpmbFont = '';
    document.head.append(font);
  }

  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z"/><path d="M6 12h16"/></svg>',
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
    .dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 999px; background: #4ade80; }
    .icon-btn { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; border: 0; border-radius: 10px; background: transparent; color: inherit; }
    .icon-btn:hover { background: rgb(255 255 255 / 0.14); }
    .icon-btn:disabled { opacity: 0.4; background: transparent; }
    .icon-btn svg { width: 18px; height: 18px; }

    .demo { padding: 10px 14px; background: #fffbeb; border-bottom: 1px solid #fde68a; color: #78350f; font-size: 12px; }
    .demo form { display: flex; gap: 8px; margin-top: 8px; }
    .demo input { flex: 1; min-width: 0; height: 44px; padding: 0 10px; border: 1px solid #fcd34d; border-radius: 10px; background: #fff; font-size: 13px; }
    .demo input:focus { outline: 2px solid #b45309; outline-offset: 0; }
    .demo button[type="submit"] { height: 44px; padding: 0 14px; border: 0; border-radius: 10px; background: #78350f; color: #fff; font-size: 13px; font-weight: 600; }
    .demo-ready { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
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
    .error { padding: 10px 12px; border: 1px solid #fecaca; border-radius: 14px; background: #fef2f2; color: #991b1b; font-size: 13px; }

    .composer { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px; border-top: 1px solid #e2e8f0; background: #fff; }
    .composer textarea { flex: 1; min-width: 0; min-height: 44px; max-height: 120px; padding: 11px 12px; border: 1px solid #cbd5e1; border-radius: 14px; background: #fff; line-height: 1.4; resize: none; }
    .composer textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 20%, transparent); }
    .send { width: 44px; height: 44px; flex-shrink: 0; display: grid; place-items: center; border: 0; border-radius: 14px; background: var(--accent); color: var(--on-accent); }
    .send svg { width: 18px; height: 18px; }
    .send:disabled { background: #e2e8f0; color: #94a3b8; }
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
            <p class="subtitle"><span class="dot"></span><span data-ref="school"></span></p>
          </div>
          <button class="icon-btn" type="button" aria-label="Mulai percakapan baru" title="Mulai percakapan baru" data-ref="reset">${ICONS.reset}</button>
          <button class="icon-btn" type="button" aria-label="Tutup Asisten SPMB" title="Tutup" data-ref="close">${ICONS.close}</button>
        </header>
        <div class="demo" data-ref="demo"></div>
        <div class="messages" data-ref="messages"></div>
        <p class="sr-only" role="status" aria-live="polite" data-ref="status"></p>
        <form class="composer" data-ref="form">
          <label class="sr-only" for="asisten-input">Tulis pertanyaan</label>
          <textarea id="asisten-input" rows="1" placeholder="Tulis pertanyaan..." data-ref="input"></textarea>
          <button class="send" type="submit" aria-label="Kirim pertanyaan" data-ref="send">${ICONS.send}</button>
        </form>
        <p class="footer">Jawaban dibuat AI dari info sekolah · Didukung <a data-ref="powered" target="_blank" rel="noopener">AsistenSPMB</a></p>
      </section>
    </div>
  `;

  const host = document.createElement('div');
  host.id = 'asisten-spmb-widget';
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
    ref.school.textContent = `${school.schoolName} · online`;
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

  function miniAvatar() {
    const avatar = make('span', 'mini-avatar');
    avatar.innerHTML = ICONS.bot; // ikon statis, bukan teks dari AI
    return avatar;
  }

  function messageRow(role, text) {
    const isUser = role === 'user';
    const row = make('div', `row ${isUser ? 'user' : 'bot'}`);
    const bubble = make('div', 'bubble');
    // Label untuk pembaca layar, lalu isi pesan lewat text node (sama amannya dengan textContent).
    bubble.append(make('span', 'sr-only', isUser ? 'Kamu: ' : 'Asisten: '), document.createTextNode(text));
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

  function renderDemo() {
    ref.demo.replaceChildren();

    if (state.apiKey) {
      const ready = make('div', 'demo-ready');
      const change = make('button', 'link-btn', 'Ganti key');
      change.type = 'button';
      change.addEventListener('click', () => {
        state.apiKey = '';
        renderDemo();
        ref.demo.querySelector('input').focus();
      });
      ready.append(make('span', '', 'Mode demo · API key aktif di tab ini'), change);
      ref.demo.append(ready);
      return;
    }

    const form = make('form');
    const input = make('input');
    input.type = 'password';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'Tempel API key Netra';
    input.setAttribute('aria-label', 'API key Netra untuk mode demo');
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
      state.apiKey = key;
      state.error = '';
      renderDemo();
      renderMessages();
      ref.input.focus();
    });
    ref.demo.append(make('p', '', 'Mode demo: masukkan API key Netra untuk mencoba. Key hanya disimpan di tab ini.'), form);
  }

  function renderMessages() {
    ref.messages.replaceChildren(messageRow('assistant', school.greeting));

    const suggestions = school.suggestions.filter((question) => question.trim());
    if (state.history.length === 0 && suggestions.length > 0) {
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

    ref.send.disabled = state.isSending;
    ref.reset.disabled = state.history.length === 0 || state.isSending;
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
      (state.apiKey ? ref.input : ref.demo.querySelector('input')).focus();
    } else {
      ref.launcher.focus();
    }
  }

  /* Mengirim pertanyaan */

  async function send(rawQuestion) {
    const question = rawQuestion.trim();
    if (!question || state.isSending) return;

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
      ref.status.textContent = `Asisten: ${reply}`;
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

  /* Event */

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
  window.AsistenSPMBWidget = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    ask: (question) => {
      setOpen(true);
      send(question);
    },
    refresh,
    // Dipakai dashboard untuk membaca dan menyimpan data sekolah.
    data: { key: STORAGE_KEY, defaults, load, save, reset, compileContext, systemPrompt: buildSystemPrompt, maxContextChars: MAX_CONTEXT_CHARS },
  };
})();
