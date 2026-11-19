---
name: ui-design-review
description: Review tampilan (UI) halaman AsistenSPMB, yaitu website index.html, halaman sekolah demo-wikrama.html, playground.html, dan widget chat widget.js. Mengecek layout desktop dan HP 375px, scroll ke samping, kontras warna, konsistensi brand (teal-limau AsistenSPMB vs warna sekolah), keadaan kosong/memuat/error, aksesibilitas, dan kejujuran copy (klaim fitur, harga, label demo). Pakai skill ini setiap kali user minta review, audit, cek, atau kritik UI/desain/tampilan ("rapi nggak?", "cek di HP", "udah bagus belum?"), sebelum demo ke investor atau sekolah, setelah mengubah HTML, class Tailwind, atau CSS widget, atau saat user kirim screenshot dan nanya tampilannya, walaupun user tidak menyebut kata "design review".
---

# UI design review AsistenSPMB

Tujuannya laporan temuan desain yang bisa langsung ditindaklanjuti, berdasarkan bukti (angka pengukuran dan screenshot), bukan selera. Proyek ini dipakai untuk demo ke investor dan sekolah, jadi tampilan yang rusak di HP atau klaim yang tidak benar lebih mahal akibatnya daripada soal estetika kecil.

Selama review, jangan mengubah file. Tulis temuannya, lalu tawarkan perbaikan di akhir. User yang memutuskan mana yang dikerjakan.

## Peta proyek

| File | Isi | Warna |
|---|---|---|
| `index.html` | Website jualan AsistenSPMB | Brand AsistenSPMB: teal `#0f766e`, deep `#042f2e`, limau `#bef264`, mint `#ccfbf1` |
| `demo-wikrama.html` | Contoh website sekolah + widget | Wikrama: navy `#001e42`, emas `#e3ce0f`, royal `#223987` |
| `playground.html` | Alat uji jawaban untuk tim/admin sekolah | Wikrama navy-emas |
| `widget.js` + `sekolah/*.js` | Tombol dan jendela chat di Shadow DOM | Dari `colors` di file sekolah |

Teknologi: HTML statis tanpa build, Tailwind v4 lewat `@tailwindcss/browser@4.1.11` dengan token warna di blok `@theme`. Widget memakai CSS biasa di dalam Shadow DOM, jadi class Tailwind tidak berlaku di sana.

Pengecualian yang disengaja: contoh percakapan di hero dan kartu "Demo langsung" di `index.html` memakai warna Wikrama untuk menunjukkan bahwa widget mengikuti warna sekolah. Itu bukan pelanggaran brand.

## Langkah

1. **Buka halaman lewat server lokal.** Pakai preview server `asisten-spmb` (port 8123, konfigurasi di `PTJawaMakmur/.claude/launch.json`) dengan `preview_start`. Kalau tidak ada, jalankan `python3 -m http.server 8123 --bind 127.0.0.1 --directory <folder repo>`. Hindari `file://`, karena `import()` pdf.js dan beberapa fitur browser bisa gagal di sana.

2. **Pemeriksaan otomatis.** Jalankan `scripts/ui-audit.js` di halaman lewat `javascript_tool`. Karena server lokal melayani folder repo, cara paling ringkas:

   ```js
   const code = await fetch('/.claude/skills/ui-design-review/scripts/ui-audit.js', { cache: 'no-store' }).then((r) => r.text());
   (0, eval)(code)
   ```

   Kalau server tidak melayani folder repo, baca filenya lalu kirim isinya sebagai `text`. Hasilnya objek berisi:
   - scroll ke samping dan elemen penyebabnya
   - elemen anak yang meluber keluar kotak induknya
   - kontras yang gagal
   - target sentuh kecil
   - kolom isian di bawah 16px
   - kontrol tanpa nama, gambar tanpa alt, dan link `_blank` tanpa `noopener`
   - urutan heading

   Level target sentuh: "gagal (<24px dan terlalu rapat)" masuk Penting, sedangkan "kecil (<24px, tapi jaraknya cukup)" dan "kecil (<44px)" masuk Kecil. Kecualinya kalau target itu tombol utama, misalnya Kirim atau Daftar.

   Lakukan untuk setiap halaman, di dua ukuran:
   - desktop: `resize_window` preset `desktop`
   - HP: preset `mobile` (375x812), lalu muat ulang halaman supaya layout dihitung ulang

   Untuk widget, buka dulu dengan `window.AsistenSPMBWidget.open()` di `demo-wikrama.html`, lalu jalankan skripnya lagi. Skrip ikut memeriksa isi Shadow DOM.

3. **Pemeriksaan visual.** Screenshot tiap halaman per bagian (pakai `scrollIntoView` ke tiap `section`). Kalau `tabs_context` bilang panel browser tersembunyi, screenshot bisa tertinggal satu langkah. Beri jeda 1–2 detik dan ambil ulang sebelum menyimpulkan ada yang salah.

4. **Keadaan layar.** Cek keadaan kosong, memuat, dan error di playground dan widget tanpa API key asli, supaya tidak memotong saldo Netra user. Caranya ada di bagian "Uji keadaan tanpa saldo". Muat ulang halaman setelah selesai.

5. **Cek kode yang tidak kelihatan di layar.** Jalankan `grep -n "innerHTML" *.html *.js` dan pastikan setiap pemakaiannya hanya untuk markup statis. Cari juga API key yang tertulis di kode atau disimpan ke `localStorage`.

6. **Checklist manual** di bawah, lalu **tulis laporan** dengan format di bagian akhir.

## Checklist

### Layout dan responsif
- Tidak ada scroll ke samping di 375px (`scrollWidth` sama dengan `clientWidth`). Penyebab paling sering di proyek ini: elemen `grid` tanpa kolom dasar, sehingga kolom melebar mengikuti isi yang panjang (blok kode, textarea, nama file). Perbaikannya `grid-cols-[minmax(0,1fr)]` pada grid itu, sementara `lg:grid-cols-…` tetap untuk layar lebar.
- Header dengan tinggi tetap (`h-16`) tidak boleh berisi teks yang bisa patah jadi beberapa baris di HP, karena isinya akan meluber keluar header (`verticalSpills` di hasil audit). Perbaikannya bisa dengan menyembunyikan subjudul di layar kecil (`hidden sm:block`), memakai `truncate` / `whitespace-nowrap`, atau mengganti `h-16` dengan `min-h-16`.
- Teks panjang (nama file PDF, email) dipotong dengan `truncate` + `min-w-0` atau dipatahkan dengan `break-all`, bukan mendorong layout.
- Daftar chat turun ke pesan terbaru. Atur `scrollTop` di dalam `requestAnimationFrame`, karena Tailwind browser baru menambahkan CSS untuk class baru setelah DOM berubah.
- Widget penuh layar di HP, dan tombol pojoknya tidak menutupi tombol penting di halaman.

### Tipografi
- Satu `h1` per halaman, dan urutan heading tidak meloncat (h2 langsung ke h4).
- Paragraf panjang dibatasi lebarnya (`max-w-xl` / `max-w-2xl`) supaya enak dibaca.
- Kolom isian minimal 16px di HP, karena iPhone otomatis nge-zoom kalau lebih kecil.

### Warna dan brand
- Kontras teks minimal 4,5:1. Teks besar (≥24px, atau ≥18,66px tebal) minimal 3:1, begitu juga ikon dan batas komponen yang penting. Tailwind v4 menulis warna sebagai `oklch`, jadi ukur lewat canvas seperti di `ui-audit.js`, jangan mengurai angka `rgb()` manual.
- Brand tidak tercampur: website memakai teal-limau, sedangkan halaman dan widget sekolah memakai warna dari `sekolah/*.js` (kecuali pengecualian di peta proyek).
- Warna status tetap bermakna: hijau = aman, kuning/amber = peringatan, merah = gagal. Jangan diganti warna brand.
- Kuning emas dan limau dipakai sebagai latar dengan teks gelap, bukan sebagai warna teks di atas putih, karena kontrasnya terlalu rendah.

### Keadaan dan interaksi
- Bagian yang memuat data punya keadaan kosong, memuat, dan error. Pesan error menjelaskan penyebab dan langkah berikutnya, dan pertanyaan yang gagal kembali ke kolom input.
- Tombol punya tampilan hover, `focus-visible`, dan disabled yang terlihat jelas.
- Target sentuh tombol utama minimal 44px (batas mutlak 24px).
- Widget: Esc menutup jendela, fokus pindah ke input saat dibuka dan kembali ke tombol pojok saat ditutup.

### Aksesibilitas
- Setiap input punya label (`for`/`id`) atau `aria-label`, dan tombol yang isinya cuma ikon punya `aria-label`.
- Pesan yang berubah (jawaban baru, error, status PDF) diumumkan lewat `role="status"` / `aria-live`.
- Ikon dekoratif memakai `aria-hidden="true"`.

### Copy dan kejujuran
Bagian ini paling penting untuk demo investor. Klaim yang tidak benar merusak kepercayaan lebih cepat daripada tampilan yang kurang rapi.
- Setiap fitur yang diklaim di `index.html` benar-benar ada di kode. Tandai klaim yang belum ada, misalnya dashboard, integrasi WhatsApp, atau statistik pemakaian.
- Tidak ada angka, testimoni, atau logo klien karangan.
- Harga sama di semua tempat: Rp300 ribu/bulan per sekolah, dibayar Rp3.600.000 per tahun.
- Halaman sekolah demo berlabel jelas "halaman demo … bukan situs resmi", dan contoh percakapan statis diberi keterangan "contoh".
- Data sekolah di `demo-wikrama.html` dan `sekolah/wikrama.js` sesuai `konteks-wikrama.txt`.

### Keamanan yang terlihat di UI
- Teks dinamis (jawaban AI, nama file, pesan error) masuk lewat `textContent` atau text node. `innerHTML` hanya untuk markup statis tanpa data dari pengguna atau AI.
- API key tidak ditulis di kode dan tidak disimpan, dan teks petunjuk di UI jujur soal itu.

## Uji keadaan tanpa saldo

Ganti `fetch` sementara dengan jawaban palsu, supaya tidak ada yang terkirim ke Netra:

```js
window.fetch = async () => {
  await new Promise((r) => setTimeout(r, 1500)); // biar keadaan "memuat" sempat terlihat
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'Jawaban uji. <img src=x onerror="window.__xss=1">' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
```

Untuk keadaan error, kembalikan `status: 401` dengan body `{ "error": { "message": "uji" } }`. Isi kolom API key dengan nilai uji seperti `kunci-uji-lokal`, jangan key asli. Setelah selesai, pastikan `window.__xss` tetap `undefined` (artinya teks AI tidak dijalankan sebagai HTML), lalu muat ulang halaman.

## Format laporan

Pakai bahasa yang sama dengan user. Urutkan temuan dari yang paling berdampak. Satu temuan untuk satu masalah, dan setiap temuan harus punya bukti. Kalau sebuah kategori tidak punya temuan, tulis "Tidak ada" supaya jelas bahwa kategori itu sudah dicek.

```
## Ringkasan
<1–2 kalimat: siap demo atau belum, dan masalah terbesarnya>

## Temuan
### Kritis — rusak atau menyesatkan, beresin sebelum demo
1. **<judul singkat>** · <halaman>, <desktop/HP>
   Bukti: <angka dari ui-audit, elemen, atau screenshot>
   Saran: <perubahan konkret: class Tailwind, CSS, atau teks pengganti>

### Penting — mengganggu, tapi tidak merusak

### Kecil — rapikan kalau sempat

## Yang sudah bagus
<poin singkat, supaya user tahu apa yang jangan diubah>

## Belum dicek
<misalnya jawaban asli pakai API key, Safari/iPhone sungguhan, browser selain Chromium>
```

Tutup dengan tawaran memperbaiki, misalnya "Mau gua beresin yang kritis dulu?". Jangan langsung mengubah file.

Kalau user butuh audit aksesibilitas WCAG yang lebih lengkap atau kritik desain umum di luar proyek ini, skill `design:accessibility-review` dan `design:design-critique` (kalau tersedia) bisa dipakai sebagai pelengkap.
