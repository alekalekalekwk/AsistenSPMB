# Sigi (Asisten SPMB)

Sigi adalah asisten chat dan suara untuk Sistem Penerimaan Murid Baru (SPMB) yang dipasang di website sekolah. Asisten menjawab pertanyaan calon murid dan orang tua seputar alur pendaftaran, jurusan, syarat berkas, dan kegiatan sekolah langsung dari data milik sekolah sendiri. Jika informasi belum tersedia di data sekolah (misalnya rincian biaya terbaru atau beasiswa), Sigi menyampaikannya secara terus terang dan mengarahkan penanya ke kontak CS SPMB sekolah.

Proyek ini dikembangkan bersama SMK Wikrama Bogor dan menyertakan data SPMB SMK Wikrama Bogor Tahun Ajaran 2027-2028 sebagai contoh demo. Seluruh kode frontend dan server ditulis tanpa proses build dan tanpa dependensi npm eksternal.

## Daftar Isi

- [Fitur Utama](#fitur-utama)
- [Halaman dalam Proyek](#halaman-dalam-proyek)
- [Struktur Repositori](#struktur-repositori)
- [Prasyarat](#prasyarat)
- [Menjalankan secara Lokal](#menjalankan-secara-lokal)
- [Deployment ke Vercel](#deployment-ke-vercel)
- [Mode Statis tanpa Server](#mode-statis-tanpa-server)
- [Memasang Widget di Website Sekolah](#memasang-widget-di-website-sekolah)
- [Ringkasan Endpoint API](#ringkasan-endpoint-api)
- [Keamanan dan Privasi](#keamanan-dan-privasi)

## Fitur Utama

- Jawaban bersumber sepenuhnya dari halaman teks sekolah dan dokumen PDF brosur yang diunggah, tanpa mengarang biaya, kuota, jadwal, atau kebijakan.
- Dashboard pengelolaan bergaya catatan memungkinkan admin sekolah menyunting info per topik, mengunggah PDF (teks diekstrak di browser dengan PDF.js), serta mengatur nama, warna, sapaan, dan saran pertanyaan widget.
- Widget chat dipasang di pojok kanan bawah website sekolah dengan dua baris `<script>`, mendukung tampilan penuh pada layar ponsel dan format jawaban Markdown sederhana.
- Mendukung dikte pertanyaan secara langsung (speech-to-text melalui Deepgram Nova-3) serta panggilan suara dua arah berbahasa Indonesia (Deepgram Flux) dengan pilihan suara dan tingkat ekspresi.
- Dapat dijalankan dalam tiga mode: server lokal Node.js (`.env`), deployment Vercel dengan proteksi password, atau hosting statis seperti GitHub Pages.

## Halaman dalam Proyek

| File | Fungsi |
| :--- | :--- |
| `index.html` | Halaman profil produk Sigi yang menjelaskan fitur, alur kerja, dan privasi. |
| `dashboard.html` | Dashboard mode demo untuk mengelola info sekolah, mengunggah PDF, mengatur tampilan widget, dan menguji chatbot. Perubahan disimpan di `localStorage` browser. |
| `demo-wikrama.html` | Contoh integrasi widget Sigi pada halaman simulasi website SMK Wikrama Bogor. |
| `playground.html` | Ruang simulasi CS untuk menguji konteks teks, unggah PDF, pemilihan model Netra, pilihan suara Deepgram, ekspresi suara, input mikrofon, dan panggilan telepon. |

## Struktur Repositori

```text
AsistenSPMB/
├── api/                    # Handler serverless Vercel (chat, speak, listen, login, status)
├── lib/
│   ├── sigi-api.mjs        # Logika API bersama untuk server lokal dan Vercel
│   └── vercel.mjs          # Pembungkus HTTP server untuk fungsi Vercel
├── sekolah/
│   └── wikrama.js          # Konfigurasi tampilan dan data SPMB bawaan SMK Wikrama Bogor
├── dashboard.html          # Dashboard admin sekolah (mode demo)
├── demo-wikrama.html       # Halaman demo integrasi website sekolah
├── index.html              # Halaman utama Sigi
├── playground.html         # Playground pengujian teks, PDF, suara, dan telepon
├── widget.js               # Skrip widget chat dan telepon
├── server.mjs              # Server lokal Node.js (file statis + proxy API)
├── konteks-wikrama.txt     # Sumber teks mentah data SPMB SMK Wikrama Bogor
├── .env.example            # Template variabel lingkungan
├── vercel.json             # Konfigurasi fungsi Vercel
└── .vercelignore           # Daftar file yang dikecualikan saat deploy ke Vercel
```

## Prasyarat

- **Node.js 20 atau lebih baru** (diperlukan oleh `server.mjs` dan `lib/sigi-api.mjs` untuk fitur standar seperti `fetch`, `AbortSignal.any`, dan `Readable.fromWeb`).
- **API key Netra** (`NETRA_API_KEY`) untuk pemrosesan chat melalui `https://api.netra.sh/v1` (model bawaan: `deepseek/deepseek-v4.1-flash`).
- **API key Deepgram** (`DEEPGRAM_API_KEY`, opsional) jika ingin mengaktifkan input mikrofon dan fitur telepon suara.
- **Proyek Supabase** (`SUPABASE_URL` & `SUPABASE_SERVICE_ROLE_KEY`, opsional) jika ingin mengaktifkan pencatatan percakapan dan dashboard analitik (`#/percakapan`).

## Menjalankan secara Lokal

Server lokal (`server.mjs`) menyajikan seluruh halaman HTML sekaligus bertindak sebagai proxy ke Netra dan Deepgram. Dengan cara ini, API key tetap berada di sisi server dan tidak perlu diketik ulang di browser.

1. Clone repositori dan masuk ke foldernya:

   ```bash
   git clone https://github.com/alekalekalekwk/AsistenSPMB.git
   cd AsistenSPMB
   ```

2. Salin `.env.example` menjadi `.env`, lalu isi API key:

   ```bash
   cp .env.example .env
   ```

   Isi file `.env`:

   ```env
   NETRA_API_KEY=isi_api_key_netra
   DEEPGRAM_API_KEY=isi_api_key_deepgram
   SUPABASE_URL=https://proyek-kamu.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=isi_service_role_key_supabase
   ```

   Untuk mengaktifkan analitik Supabase, buka **SQL Editor** di dashboard Supabase, lalu jalankan seluruh isi file `supabase/schema.sql`.

3. Periksa apakah API key terbaca dan diterima penyedia layanan (tanpa menjalankan AI dan tanpa memotong saldo):

   ```bash
   node server.mjs --cek
   ```

4. Jalankan server lokal:

   ```bash
   node server.mjs
   ```

5. Buka `http://127.0.0.1:8123` di browser.

Catatan penggunaan lokal:
- Port bawaan adalah `8123`. Untuk mengganti port, jalankan `PORT=8130 node server.mjs` (pada PowerShell: `$env:PORT=8130; node server.mjs`).
- File `.env` dibaca ulang pada setiap permintaan, sehingga setelah mengubah key cukup muat ulang halaman browser tanpa mematikan server.
- Server lokal hanya mengikat ke `127.0.0.1` dan menolak host selain `localhost` atau `127.0.0.1`.

## Deployment ke Vercel

Repositori ini siap di-deploy ke Vercel tanpa langkah build (`"framework": null` di `vercel.json`). Batas durasi fungsi API diatur hingga 300 detik untuk mendukung percakapan dan streaming audio.

Atur **Environment Variables** berikut pada pengaturan proyek Vercel:

| Variabel | Wajib | Keterangan |
| :--- | :--- | :--- |
| `NETRA_API_KEY` | Ya | API key Netra untuk endpoint `/api/chat`. |
| `DEEPGRAM_API_KEY` | Opsional | API key Deepgram untuk mikrofon (`/api/listen`) dan suara telepon (`/api/speak`). |
| `SUPABASE_URL` | Opsional | URL proyek Supabase untuk pencatatan percakapan dan analitik `#/percakapan`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Opsional | Service role key Supabase (hanya dipakai backend; tabel terkunci RLS deny-all untuk publik). |
| `SIGI_PASSWORD` | Ya | Password masuk halaman Sigi di Vercel, minimal 12 karakter. Jika kosong atau kurang dari 12 karakter, seluruh endpoint API akan menolak permintaan. |

Setelah deploy, pengunjung halaman Sigi di Vercel diminta memasukkan password terlebih dahulu. Sesi masuk disimpan dalam cookie `__Host-sigi` (`HttpOnly`, `Secure`, `SameSite=Strict`) selama 12 jam. Mengubah `SIGI_PASSWORD` otomatis mengakhiri seluruh sesi yang sedang aktif.

## Mode Statis tanpa Server

Seluruh file frontend (`index.html`, `dashboard.html`, `demo-wikrama.html`, `playground.html`) dapat di-host secara statis, misalnya melalui GitHub Pages. Pada mode tanpa server, widget dan playground menampilkan kolom input untuk API key Netra dan Deepgram secara langsung di browser. Key tersebut hanya disimpan di memori tab aktif dan otomatis hilang ketika halaman dimuat ulang.

Mode ini ditujukan untuk simulasi atau demonstrasi, bukan untuk pengunjung publik di website produksi.

## Memasang Widget di Website Sekolah

Tambahkan dua baris skrip berikut sebelum tag penutup `</body>` pada halaman website sekolah:

```html
<script src="sekolah/wikrama.js"></script>
<script src="widget.js" defer></script>
```

- Baris pertama memuat konfigurasi sekolah (`window.Sigi`) yang berisi nama sekolah, palet warna, pesan sapaan, saran pertanyaan, serta daftar halaman informasi SPMB. Untuk sekolah lain, buat salinan `sekolah/wikrama.js` dan sesuaikan isinya.
- Baris kedua memuat tombol dan panel widget di pojok kanan bawah halaman.
- Pada versi produksi untuk pengunjung publik, pastikan permintaan AI diteruskan melalui server sendiri agar API key tidak terekspos di sisi klien.

## Ringkasan Endpoint API

Seluruh endpoint berikut dilayani oleh `server.mjs` (lokal) dan folder `api/` (Vercel) melalui modul bersama `lib/sigi-api.mjs`:

| Metode | Jalur | Keterangan |
| :--- | :--- | :--- |
| `GET` | `/api/status` | Memeriksa status login dan kesiapan `NETRA_API_KEY` serta `DEEPGRAM_API_KEY`. |
| `POST` | `/api/login` | Memverifikasi `SIGI_PASSWORD` (khusus Vercel) dan mengeluarkan cookie sesi. |
| `POST` | `/api/chat` | Meneruskan permintaan percakapan ke Netra (`max_tokens` dibatasi maksimal 8192). |
| `POST` | `/api/speak` | Mengubah teks balasan menjadi audio MP3 melalui Deepgram Flux (`/v2/speak`). |
| `WS` | `/api/listen` | Proxy WebSocket untuk transkripsi suara langsung melalui Deepgram (`/v1/listen`). |
| `POST` | `/api/events` | Mencatat event ringan widget (`widget_opened`, klik saran, mulai/selesai telepon) ke Supabase. |
| `GET` | `/api/analytics` | Mengambil ringkasan percakapan, pertanyaan populer/belum terjawab, dan jam ramai WIB dari Supabase. |

## Keamanan dan Privasi

- Pada mode server lokal dan Vercel, API key dan `SUPABASE_SERVICE_ROLE_KEY` hanya dibaca di backend dan tidak pernah dikirim ke browser. Seluruh tabel Supabase memakai RLS deny-all untuk `anon`/`authenticated`.
- Seluruh endpoint API memeriksa header `Host` dan `Origin` (same-origin) untuk mencegah penyalahgunaan saldo dari situs pihak ketiga atau DNS rebinding.
- Log konsol server hanya mencatat status HTTP, durasi, ID permintaan, sidik jari key (6 karakter hash SHA-256), dan ringkasan error.
- Ketika Supabase aktif, pesan percakapan yang disimpan ke database disensor otomatis dari pola PII (NIK, NISN, nomor KK, nomor rekening, nomor HP, dan email) dan memakai `visitor_session_id` acak tanpa IP address.
- Aturan sistem melarang asisten meminta data sensitif seperti NIK, NISN, nomor KK, password, atau nomor rekening melalui percakapan. Pendaftaran tetap dilakukan melalui portal resmi sekolah.
