# Maskot Kijang SPMB

Paket berisi maskot SVG dengan enam state animasi, satu SVG master yang dapat dikendalikan, dan contoh preview interaktif.

## Isi paket

- `mascot.svg` — SVG master, default `data-state="idle"`. Untuk mengganti animasi secara dinamis, masukkan SVG ini **inline** ke DOM.
- `states/idle.svg` — gerakan idle dan kedipan mata.
- `states/listening.svg` — gelombang pada headset saat mendengarkan.
- `states/thinking.svg` — gelembung tiga titik saat berpikir.
- `states/speaking.svg` — mulut bergerak saat asisten mengeluarkan suara.
- `states/greeting.svg` — tangan melambai.
- `states/success.svg` — tanda centang dan kilau saat proses berhasil.
- `mascot-controller.js` — helper kecil untuk mengubah state.
- `demo.html` — preview mandiri. Buka file ini di browser.

## Cara paling sederhana: tukar file SVG

Cocok bila maskot hanya ditampilkan sebagai gambar. Ubah `src` sesuai state:

```html
<img id="spmb-mascot" src="/assets/kijang/states/idle.svg" alt="Asisten SPMB">
<script>
  const mascot = document.querySelector('#spmb-mascot');
  function setMascotState(state) {
    mascot.src = `/assets/kijang/states/${state}.svg`;
  }

  // Panggil dari lifecycle assistant / audio milik aplikasi.
  // setMascotState('listening');
  // setMascotState('thinking');
  // setMascotState('speaking');
  // setMascotState('idle');
</script>
```

## Cara realtime: satu SVG, ganti state tanpa reload

Masukkan isi `mascot.svg` langsung ke HTML/komponen (bukan melalui tag `<img>`), lalu:

```html
<div id="assistant-mascot">
  <!-- Tempel seluruh isi mascot.svg di sini -->
</div>
<script type="module">
  import { createMascotController } from './mascot-controller.js';
  const mascot = createMascotController('#assistant-mascot svg');

  // Hubungkan pemanggilan ini dengan event SDK realtime yang digunakan aplikasi.
  function onUserStartsTalking() { mascot.listen(); }
  function onAssistantStartsProcessing() { mascot.think(); }
  function onAssistantAudioStarts() { mascot.speak(); }
  function onAssistantAudioEnds() { mascot.idle(); }
  function onAssistantGreets() { mascot.greet(); }
  function onFormSubmittedSuccessfully() { mascot.success(); }
</script>
```

Nama callback di atas adalah contoh adapter aplikasi, bukan nama event dari SDK tertentu. Saat audio jawaban benar-benar mulai diputar, set state `speaking`; saat playback selesai atau terputus, kembalikan ke `idle`. State `listening` sebaiknya aktif ketika input mikrofon sedang diterima.

## Catatan implementasi

- Keenam SVG state bersifat mandiri, transparan, dan dapat dipakai sebagai file gambar biasa.
- `mascot.svg` menggunakan atribut `data-state`: `idle`, `listening`, `thinking`, `speaking`, `greeting`, atau `success`.
- SVG memiliki fallback `prefers-reduced-motion` untuk pengguna yang mengurangi animasi di perangkatnya.
- Warna utama: navy `#102D62`, cokelat `#C78353`, kuning `#F3D45A`, dan krem `#FFF3D9`.
- Emblem dada memakai huruf `S`; ganti elemen `<text>` pada SVG bila ingin logo atau inisial sekolah tertentu.
