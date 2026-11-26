/*
 * Trailer Sigi (sekitar 40 detik) di landing.
 * Pasang: <link rel="stylesheet" href="trailer.css"> dan <div id="sigi-trailer"></div> + <script src="trailer.js" defer>.
 *
 * Semua isi panggung adalah markup statis di file ini (tanpa data dari pengguna atau AI), jadi aman memakai innerHTML.
 * Pertanyaan dan jawaban mengikuti konteks-wikrama.txt; nama dan nomor calon pendaftar hanya contoh.
 * Harga sengaja tidak ditampilkan.
 */
(() => {
  'use strict';

  const mount = document.getElementById('sigi-trailer');
  if (!mount) return;
  // Alamat aset dihitung dari lokasi trailer.js, supaya halaman di subfolder (tools/trailer-render.html) juga bisa.
  const BASE = new URL('.', document.currentScript?.src || location.href);

  const W = 960;
  const DURATION = 40000;
  const KIJANG_HEAD = '<svg viewBox="24 62 432 310" aria-hidden="true"><g fill="none" stroke="#81502F" stroke-width="14" stroke-linecap="round" stroke-linejoin="round"><path d="M190 160 C185 132 181 107 176 78 M181 119 L151 99 M181 119 L183 88"/><path d="M290 160 C295 132 299 107 304 78 M299 119 L329 99 M299 119 L297 88"/></g><path d="M139 192 C105 159 57 153 35 181 C14 207 45 228 83 222 C111 218 132 207 145 199Z" fill="#C07D4E" stroke="#75492F" stroke-width="6"/><path d="M341 192 C375 159 423 153 445 181 C466 207 435 228 397 222 C369 218 348 207 335 199Z" fill="#C07D4E" stroke="#75492F" stroke-width="6"/><path d="M121 190 C94 173 57 177 44 194 C36 205 54 211 80 207 C99 204 114 198 121 190Z" fill="#F2B6A0"/><path d="M359 190 C386 173 423 177 436 194 C444 205 426 211 400 207 C381 204 366 198 359 190Z" fill="#F2B6A0"/><path d="M117 231 C117 159 169 125 240 125 C311 125 363 159 363 231 L359 284 C355 337 310 365 240 365 C170 365 125 337 121 284Z" fill="#D69A66" stroke="#75492F" stroke-width="6" stroke-linejoin="round"/><ellipse cx="190" cy="238" rx="18" ry="23" fill="#241A16"/><ellipse cx="290" cy="238" rx="18" ry="23" fill="#241A16"/><ellipse cx="196" cy="230" rx="7" ry="8.5" fill="#fff"/><ellipse cx="296" cy="230" rx="7" ry="8.5" fill="#fff"/><path d="M169 293 C177 270 204 259 240 259 C276 259 303 270 311 293 C319 319 295 346 263 353 C248 357 232 357 217 353 C185 346 161 319 169 293Z" fill="#FAEBCF" stroke="#E8D1AB" stroke-width="3"/><ellipse cx="240" cy="298" rx="18" ry="12" fill="#3B2920"/><path d="M220 321 C229 336 251 336 260 321" fill="none" stroke="#4B3326" stroke-width="6" stroke-linecap="round"/></svg>';
  const ICON_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.52.85l10.4-6.5a1 1 0 0 0 0-1.7L9.52 4.65A1 1 0 0 0 8 5.5z"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  const ICON_LOGO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="m8.5 10 2.5 2.5 4.5-4.5"/></svg>';
  const ICON_CURSOR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 2.5 19.5 13l-7 1.3-3.7 6.2z" fill="#fff" stroke="#042f2e" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  // Teks besar tiap adegan, juga dipakai untuk pembaca layar dan naskah di bawah trailer.
  const CAPTIONS = [
    'Jam 9 malam. CS sekolah sudah pulang.',
    'Kenalin, Sigi.',
    'Jawabannya dari data sekolah sendiri.',
    'Yang serius bisa minta dihubungi panitia.',
    'Langsung masuk ke dashboard panitia.',
    'Di website, lewat telepon, atau di stan pameran.',
    'Jawab calon murid kapan saja.',
  ];

  const STAGE = `
    <section class="tr-scene tr-s1" data-scene="1">
      <div class="tr-phone tr-pop" data-el="phone">
        <div class="tr-phone-head"><span class="tr-phone-ava">CS</span><div><div class="tr-phone-name">CS SPMB Sekolah</div><div class="tr-phone-sub">terakhir dilihat pukul 16.02</div></div></div>
        <p class="tr-msg tr-pop" data-el="msg">Permisi, anak saya suka main game sama gambar. Cocoknya jurusan apa ya?<span class="tr-msg-meta">21.40 · terkirim</span></p>
      </div>
      <p class="tr-clock tr-pop" data-el="clock">21.40<small>Selasa malam</small></p>
      <p class="tr-cap tr-pop" data-el="cap1">${CAPTIONS[0]}</p>
    </section>

    <section class="tr-scene tr-s2" data-scene="2">
      <div class="tr-kijang-slot" data-slot="2"></div>
      <p class="tr-cap tr-pop" data-el="cap2">${CAPTIONS[1]}</p>
      <p class="tr-sub tr-pop" data-el="sub2">Asisten SPMB yang dipasang di website sekolah. Siap jawab, termasuk jam 9 malam.</p>
    </section>

    <section class="tr-scene tr-s3" data-scene="3">
      <div class="tr-site">
        <div class="tr-site-bar"><span class="tr-site-url">sigi-spmb.vercel.app/demo-wikrama</span></div>
        <div class="tr-site-hero"><b>Siap jadi bagian dari SMK Wikrama Bogor?</b><span>Pendaftaran SPMB 2027–2028 sudah dibuka.</span><i>Halaman demo Sigi dengan data SPMB SMK Wikrama Bogor.</i></div>
      </div>
      <div class="tr-widget">
        <div class="tr-w-head"><span class="tr-w-ava">${KIJANG_HEAD}</span><div><div class="tr-w-title">Asisten SPMB</div><div class="tr-w-sub">SMK Wikrama Bogor</div></div></div>
        <div class="tr-w-body" data-el="wbody">
          <p class="tr-b-user tr-pop" data-el="q">Anak saya suka main game sama gambar, cocoknya jurusan apa?</p>
          <span class="tr-dots" data-el="dots" hidden><i></i><i></i><i></i></span>
          <p class="tr-b-bot tr-pop" data-el="a" hidden>Ada dua yang cocok, Kak: <b>PPLG</b> kalau pengen bikin game-nya, dan <b>DKV</b> kalau lebih suka desain dan animasinya.</p>
          <div class="tr-lead tr-pop" data-el="lead" hidden>
            <div data-el="leadOffer">
              <p class="tr-lead-t">Mau dihubungi panitia lewat WhatsApp?</p>
              <p class="tr-lead-d">Panitia bisa kirim info lengkap dan bantu proses daftar.</p>
              <span class="tr-btn" data-el="leadYes">Boleh, isi data</span>
            </div>
            <div data-el="leadForm" hidden>
              <p class="tr-lead-t">Data untuk dihubungi panitia</p>
              <div class="tr-field" data-el="fName" data-ph="Nama"></div>
              <div class="tr-field" data-el="fWa" data-ph="Nomor WhatsApp"></div>
              <div class="tr-check" data-el="fOk"><i></i><span>Saya setuju dihubungi panitia SPMB.</span></div>
              <span class="tr-btn" data-el="leadSend">Kirim</span>
            </div>
            <div class="tr-done" data-el="leadDone" hidden>${ICON_CHECK}<div><p class="tr-lead-t">Terima kasih, Nadia!</p><p class="tr-lead-d">Panitia akan menghubungi lewat WhatsApp.</p></div></div>
          </div>
        </div>
      </div>
      <p class="tr-cap tr-pop" data-el="cap3">${CAPTIONS[2]}</p>
      <p class="tr-cap tr-pop" data-el="cap4" hidden>${CAPTIONS[3]}</p>
    </section>

    <section class="tr-scene tr-s5" data-scene="5">
      <p class="tr-cap tr-pop" data-el="cap5">${CAPTIONS[4]}</p>
      <p class="tr-sub tr-pop" data-el="sub5">Tinggal klik Chat WhatsApp, lalu tandai siapa yang sudah dihubungi.</p>
      <div class="tr-dash tr-pop" data-el="dash">
        <div class="tr-dash-head"><b>Calon pendaftar</b><span class="tr-badge" data-el="badge" hidden>1 belum dihubungi</span></div>
        <ul class="tr-rows" data-el="rows">
          <li class="tr-row is-new tr-slide" data-el="newRow" hidden><div><b>Nadia Putri</b> <em>minat PPLG</em><small>0812-xxxx-2210 · baru saja</small></div><span class="tr-act" data-el="newAct">Chat WhatsApp</span></li>
          <li class="tr-row"><div><b>Bu Rahma</b> <em>minat Perhotelan</em><small>0857-xxxx-0913 · tadi malam, 21.52</small></div><span class="tr-act is-status">Sudah dihubungi</span></li>
          <li class="tr-row"><div><b>Dimas A.</b> <em>minat TJKT</em><small>0896-xxxx-4471 · kemarin</small></div><span class="tr-act is-status">Sudah mendaftar</span></li>
        </ul>
      </div>
      <span class="tr-cursor" data-el="cursor">${ICON_CURSOR}</span>
    </section>

    <section class="tr-scene tr-s6" data-scene="6">
      <div class="tr-kijang-slot" data-slot="6"></div>
      <p class="tr-kios-tamu tr-pop" data-el="tamu">Tamu di stan pameran: “Ekskul buat anak PPLG ada apa aja?”</p>
      <p class="tr-kios-bubble tr-pop" data-el="kios">Ada Gamedev Club, Python Club, sampai IoT Club, Kak!</p>
      <p class="tr-cap tr-pop" data-el="cap6">${CAPTIONS[5]}</p>
    </section>

    <section class="tr-scene tr-s7" data-scene="7">
      <div class="tr-kijang-slot" data-slot="7"></div>
      <div class="tr-end-logo tr-pop" data-el="logo"><span>${ICON_LOGO}</span>Sigi</div>
      <p class="tr-end-t tr-pop" data-el="endT">${CAPTIONS[6]}</p>
      <p class="tr-end-d tr-pop" data-el="endD">Asisten SPMB untuk website sekolah. Data pertanyaan dan calon pendaftar masuk ke dashboard sekolah.</p>
    </section>`;

  mount.innerHTML = `
    <div class="tr-frame" role="region" aria-label="Trailer Sigi, sekitar 40 detik">
      <div class="tr-stage" aria-hidden="true"></div>
      <p class="sr-only" aria-live="polite" data-ref="live"></p>
      <div class="tr-poster" data-ref="poster">
        <button type="button" class="tr-play" data-ref="play">${ICON_PLAY}Putar trailer (40 detik)</button>
      </div>
    </div>
    <div class="tr-bar" data-ref="bar" hidden>
      <button type="button" class="tr-ctl" data-ref="pause">Jeda</button>
      <div class="tr-progress" aria-hidden="true"><i data-ref="progress"></i></div>
      <button type="button" class="tr-ctl" data-ref="replay">Ulang</button>
    </div>`;

  const frame = mount.querySelector('.tr-frame');
  const stage = mount.querySelector('.tr-stage');
  const ui = {};
  for (const node of mount.querySelectorAll('[data-ref]')) ui[node.dataset.ref] = node;

  /* Ukuran: panggung 960x540 diperkecil mengikuti lebar bingkai */
  // Di layar sempit teks kecil (sub-judul) tidak terbaca, jadi disembunyikan; teks besar tiap adegan tetap tampil.
  const fit = () => {
    stage.style.transform = `scale(${frame.clientWidth / W})`;
    frame.classList.toggle('is-small', frame.clientWidth < 560);
  };
  new ResizeObserver(fit).observe(frame);
  fit();

  /* Maskot: satu SVG (assets/kijang/states/idle.svg) yang dipindah antar adegan.
     <style> bawaannya dibuang supaya animasinya tidak bocor ke maskot lain di halaman; gayanya ada di trailer.css. */
  let kijangMarkup = '';
  const kijangReady = fetch(new URL('assets/kijang/states/idle.svg', BASE))
    .then((res) => (res.ok ? res.text() : ''))
    .then((text) => {
      let svg = text.slice(text.indexOf('<svg'));
      svg = svg.replace(/<style>[\s\S]*?<\/style>/, '');
      svg = svg.replace(/id="([^"]+)"/g, 'id="tr-$1"').replace(/url\(#([^)]+)\)/g, 'url(#tr-$1)');
      svg = svg.replace(/aria-labelledby="[^"]*"/, 'aria-hidden="true"').replace('<svg ', '<svg class="tr-kijang" ');
      kijangMarkup = svg;
    })
    .catch(() => {});

  let el = {};
  let kijang = null;

  function render() {
    stage.innerHTML = STAGE;
    el = {};
    for (const node of stage.querySelectorAll('[data-el]')) el[node.dataset.el] = node;
    const holder = document.createElement('div');
    holder.innerHTML = kijangMarkup;
    kijang = holder.firstElementChild;
  }

  const scene = (n) => {
    for (const s of stage.querySelectorAll('.tr-scene')) s.classList.toggle('is-on', s.dataset.scene === String(n));
  };
  const pop = (name) => {
    const node = el[name];
    if (!node) return;
    node.hidden = false;
    node.classList.remove('is-in');
    void node.offsetWidth; // mulai ulang animasi masuk
    node.classList.add('is-in');
  };
  const hide = (name) => { if (el[name]) el[name].hidden = true; };
  const kijangTo = (slot, state) => {
    if (!kijang) return;
    stage.querySelector(`[data-slot="${slot}"]`)?.append(kijang);
    kijang.removeAttribute('data-state');
    void kijang.getBoundingClientRect();
    kijang.setAttribute('data-state', state);
  };
  const say = (i) => { ui.live.textContent = CAPTIONS[i]; };
  const press = (name, ms = 220) => {
    el[name]?.classList.add('is-pressed');
    return ms;
  };

  /* Timeline: [waktu ms, aksi]. Diputar oleh jam requestAnimationFrame, jadi bisa dijeda. */
  const steps = [];
  const at = (t, fn) => steps.push({ t, fn });
  const typeInto = (name, text, start, dur) => {
    for (let i = 1; i <= text.length; i++) at(start + Math.round((dur * i) / text.length), () => { el[name].textContent = text.slice(0, i); });
  };

  at(0, () => { scene(1); say(0); });
  at(250, () => pop('phone'));
  at(900, () => pop('msg'));
  at(1500, () => pop('clock'));
  at(2300, () => pop('cap1'));

  at(5000, () => { scene(2); kijangTo(2, 'greeting'); say(1); });
  at(5400, () => pop('cap2'));
  at(6100, () => pop('sub2'));

  at(9000, () => { scene(3); say(2); });
  at(9400, () => pop('q'));
  at(10100, () => { el.dots.hidden = false; });
  at(11700, () => { hide('dots'); pop('a'); });
  at(12300, () => pop('cap3'));

  at(16200, () => { hide('cap3'); pop('cap4'); say(3); hide('q'); pop('lead'); });
  at(17600, () => press('leadYes'));
  at(17900, () => { hide('leadOffer'); el.leadForm.hidden = false; });
  typeInto('fName', 'Nadia Putri', 18300, 700);
  typeInto('fWa', '0812 3456 2210', 19200, 800);
  at(20300, () => el.fOk.classList.add('is-checked'));
  at(20900, () => press('leadSend'));
  at(21200, () => { hide('leadForm'); el.leadDone.hidden = false; });

  at(24000, () => { scene(5); say(4); });
  at(24300, () => pop('cap5'));
  at(24500, () => pop('dash'));
  at(25300, () => { pop('newRow'); pop('badge'); });
  at(25900, () => pop('sub5'));
  at(26400, () => el.cursor.classList.add('is-on'));
  at(26500, () => {
    // Kursor bergerak ke tombol Chat WhatsApp di baris baru (koordinat panggung).
    const r = el.newAct.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    const k = frame.clientWidth / W;
    el.cursor.style.left = `${(r.left - s.left) / k + 30}px`;
    el.cursor.style.top = `${(r.top - s.top) / k + 14}px`;
  });
  at(27600, () => press('newAct'));
  at(28000, () => {
    el.newAct.classList.remove('is-pressed');
    el.newAct.classList.add('is-status');
    el.newAct.textContent = 'Sudah dihubungi';
    el.newRow.classList.remove('is-new');
    el.badge.textContent = 'Semua sudah dihubungi';
  });

  at(30000, () => { scene(6); kijangTo(6, 'idle'); say(5); });
  at(30400, () => pop('tamu'));
  at(31200, () => { pop('kios'); kijangTo(6, 'speaking'); });
  at(32000, () => pop('cap6'));
  at(35600, () => kijangTo(6, 'idle'));

  at(36000, () => { scene(7); kijangTo(7, 'greeting'); say(6); });
  at(36300, () => pop('logo'));
  at(36700, () => pop('endT'));
  at(37400, () => pop('endD'));
  steps.sort((a, b) => a.t - b.t);

  /* Jam */
  let elapsed = 0;
  let next = 0;
  let playing = false;
  let last = 0;
  let raf = 0;

  function tick(now) {
    if (!playing) return;
    elapsed += now - last;
    last = now;
    while (next < steps.length && steps[next].t <= elapsed) steps[next++].fn();
    ui.progress.style.width = `${Math.min(100, (elapsed / DURATION) * 100)}%`;
    if (elapsed >= DURATION) {
      finish();
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    cancelAnimationFrame(raf);
    render();
    elapsed = 0;
    next = 0;
    frame.classList.remove('is-paused');
    ui.poster.hidden = true;
    ui.bar.hidden = false;
    ui.pause.textContent = 'Jeda';
    ui.pause.hidden = false;
    playing = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
    ui.pause.focus();
  }

  function togglePause() {
    if (playing) {
      playing = false;
      cancelAnimationFrame(raf);
      frame.classList.add('is-paused');
      ui.pause.textContent = 'Lanjut';
    } else {
      playing = true;
      frame.classList.remove('is-paused');
      ui.pause.textContent = 'Jeda';
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  function finish() {
    playing = false;
    ui.progress.style.width = '100%';
    ui.pause.hidden = true;
    ui.replay.textContent = 'Putar lagi';
    ui.replay.focus();
  }

  // Sampul: adegan "Kenalin, Sigi" dalam keadaan diam, dengan tombol Putar di tengah.
  function poster() {
    render();
    scene(2);
    kijangTo(2, 'idle');
    for (const name of ['cap2', 'sub2']) { el[name].classList.add('is-in'); }
  }

  ui.play.addEventListener('click', () => kijangReady.then(start));
  ui.pause.addEventListener('click', togglePause);
  ui.replay.addEventListener('click', () => { ui.replay.textContent = 'Ulang'; kijangReady.then(start); });
  // Trailer berhenti kalau tab disembunyikan, supaya tidak berjalan tanpa ditonton.
  document.addEventListener('visibilitychange', () => { if (document.hidden && playing) togglePause(); });

  kijangReady.then(poster);
  poster();

  // Dipakai tools/render-trailer.mjs untuk merekam trailer jadi video: mulai dari awal tanpa tombol.
  window.SigiTrailer = { ready: kijangReady, start, duration: DURATION };
})();
