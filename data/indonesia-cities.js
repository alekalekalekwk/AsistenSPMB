/*
 * Kamus Provinsi, Kota/Kabupaten Indonesia, jenjang sekolah, dan proyeksi koordinat
 * ke SVG peta titik Nusantara (viewBox 0 0 960 380) di index.html.
 *
 * Sumber tunggal: dipakai langsung oleh browser (<script src="data/indonesia-cities.js">)
 * dan oleh backend Node.js (lib/locations.mjs) tanpa dependensi eksternal.
 */
(function (root) {
  'use strict';

  const LEVELS = ['SMK', 'SMA', 'MA', 'SMP', 'MTs', 'SD', 'MI', 'Lainnya'];

  // Format: [namaProvinsi, [[namaKotaKab, lat, lng], ...]]
  const RAW_PROVINCES = [
    ['Aceh', [
      ['Kota Banda Aceh', 5.5483, 95.3238],
      ['Kota Sabang', 5.8932, 95.3193],
      ['Kota Lhokseumawe', 5.1801, 97.1507],
      ['Kota Langsa', 4.4683, 97.9683],
      ['Kota Subulussalam', 2.6425, 98.0056],
      ['Kab. Aceh Besar', 5.3822, 95.5150],
      ['Kab. Pidie', 5.0833, 96.1167],
      ['Kab. Bireuen', 5.2030, 96.7009],
      ['Kab. Aceh Utara', 5.0517, 97.3181],
      ['Kab. Aceh Tengah', 4.6275, 96.8428],
      ['Kab. Aceh Barat', 4.4543, 96.1856],
    ]],
    ['Sumatera Utara', [
      ['Kota Medan', 3.5952, 98.6722],
      ['Kota Binjai', 3.6001, 98.4854],
      ['Kota Tebing Tinggi', 3.3285, 99.1625],
      ['Kota Pematangsiantar', 2.9595, 99.0687],
      ['Kota Tanjungbalai', 2.9667, 99.8000],
      ['Kota Sibolga', 1.7427, 98.7792],
      ['Kota Padangsidimpuan', 1.3795, 99.2720],
      ['Kota Gunungsitoli', 1.2833, 97.6167],
      ['Kab. Deli Serdang', 3.4210, 98.7160],
      ['Kab. Langkat', 3.7700, 98.2200],
      ['Kab. Karo', 3.1000, 98.5000],
      ['Kab. Simalungun', 2.9000, 99.0000],
      ['Kab. Asahan', 2.9800, 99.6200],
      ['Kab. Labuhanbatu', 2.1000, 99.8300],
      ['Kab. Toba', 2.3333, 99.0667],
    ]],
    ['Sumatera Barat', [
      ['Kota Padang', -0.9471, 100.4172],
      ['Kota Bukittinggi', -0.3056, 100.3692],
      ['Kota Payakumbuh', -0.2202, 100.6309],
      ['Kota Padang Panjang', -0.4667, 100.4000],
      ['Kota Solok', -0.7897, 100.6561],
      ['Kota Sawahlunto', -0.6833, 100.7833],
      ['Kota Pariaman', -0.6267, 100.1200],
      ['Kab. Agam', -0.2500, 100.1667],
      ['Kab. Tanah Datar', -0.4550, 100.5920],
      ['Kab. Lima Puluh Kota', -0.1500, 100.6333],
      ['Kab. Padang Pariaman', -0.5500, 100.2833],
      ['Kab. Pesisir Selatan', -1.5500, 100.6500],
    ]],
    ['Riau', [
      ['Kota Pekanbaru', 0.5071, 101.4478],
      ['Kota Dumai', 1.6671, 101.4432],
      ['Kab. Kampar', 0.3333, 101.0333],
      ['Kab. Siak', 0.8000, 102.0500],
      ['Kab. Bengkalis', 1.4800, 102.1100],
      ['Kab. Pelalawan', 0.3500, 101.8500],
      ['Kab. Indragiri Hulu', -0.3700, 102.5300],
      ['Kab. Indragiri Hilir', -0.3300, 103.1600],
      ['Kab. Rokan Hilir', 2.1500, 100.8200],
      ['Kab. Rokan Hulu', 0.8800, 100.3000],
    ]],
    ['Kepulauan Riau', [
      ['Kota Batam', 1.0456, 104.0305],
      ['Kota Tanjungpinang', 0.9168, 104.4433],
      ['Kab. Bintan', 1.0800, 104.4800],
      ['Kab. Karimun', 1.0500, 103.4000],
      ['Kab. Natuna', 3.9500, 108.3800],
    ]],
    ['Jambi', [
      ['Kota Jambi', -1.6101, 103.6131],
      ['Kota Sungai Penuh', -2.0630, 101.3960],
      ['Kab. Muaro Jambi', -1.5500, 103.8200],
      ['Kab. Batanghari', -1.7200, 103.2700],
      ['Kab. Bungo', -1.5000, 102.1100],
      ['Kab. Kerinci', -2.0800, 101.4800],
      ['Kab. Tanjung Jabung Barat', -0.8200, 103.4600],
      ['Kab. Merangin', -2.0700, 102.2700],
    ]],
    ['Sumatera Selatan', [
      ['Kota Palembang', -2.9761, 104.7754],
      ['Kota Prabumulih', -3.4328, 104.2356],
      ['Kota Lubuklinggau', -3.2967, 102.8617],
      ['Kota Pagar Alam', -4.0200, 103.2500],
      ['Kab. Banyuasin', -2.8800, 104.3800],
      ['Kab. Ogan Ilir', -3.2300, 104.6500],
      ['Kab. Ogan Komering Ilir', -3.3800, 104.8300],
      ['Kab. Ogan Komering Ulu', -4.1300, 104.1700],
      ['Kab. Muara Enim', -3.6500, 103.7800],
      ['Kab. Lahat', -3.7900, 103.5400],
      ['Kab. Musi Banyuasin', -2.8800, 103.8400],
    ]],
    ['Kepulauan Bangka Belitung', [
      ['Kota Pangkalpinang', -2.1316, 106.1169],
      ['Kab. Bangka', -1.8600, 106.1100],
      ['Kab. Bangka Tengah', -2.4900, 106.4100],
      ['Kab. Belitung', -2.7400, 107.6400],
      ['Kab. Belitung Timur', -2.8400, 108.2700],
    ]],
    ['Bengkulu', [
      ['Kota Bengkulu', -3.7928, 102.2608],
      ['Kab. Rejang Lebong', -3.4600, 102.5200],
      ['Kab. Bengkulu Utara', -3.4300, 102.1900],
      ['Kab. Bengkulu Selatan', -4.4600, 102.9100],
      ['Kab. Mukomuko', -2.5700, 101.1200],
    ]],
    ['Lampung', [
      ['Kota Bandar Lampung', -5.4292, 105.2610],
      ['Kota Metro', -5.1131, 105.3067],
      ['Kab. Lampung Selatan', -5.7300, 105.5900],
      ['Kab. Lampung Tengah', -4.9700, 105.2100],
      ['Kab. Lampung Utara', -4.8300, 104.8800],
      ['Kab. Lampung Timur', -5.0900, 105.5500],
      ['Kab. Pringsewu', -5.3600, 104.9700],
      ['Kab. Pesawaran', -5.4300, 105.0800],
      ['Kab. Tanggamus', -5.4900, 104.6200],
    ]],
    ['DKI Jakarta', [
      ['Jakarta Pusat', -6.1862, 106.8341],
      ['Jakarta Selatan', -6.2615, 106.8106],
      ['Jakarta Timur', -6.2250, 106.9004],
      ['Jakarta Barat', -6.1674, 106.7637],
      ['Jakarta Utara', -6.1384, 106.8640],
      ['Kab. Kepulauan Seribu', -5.7400, 106.5800],
    ]],
    ['Banten', [
      ['Kota Tangerang', -6.1783, 106.6319],
      ['Kota Tangerang Selatan', -6.2886, 106.7179],
      ['Kota Serang', -6.1104, 106.1640],
      ['Kota Cilegon', -6.0025, 106.0111],
      ['Kab. Tangerang', -6.2600, 106.4800],
      ['Kab. Serang', -6.1500, 106.0800],
      ['Kab. Lebak', -6.5600, 106.2500],
      ['Kab. Pandeglang', -6.3100, 106.1000],
    ]],
    ['Jawa Barat', [
      ['Kota Bogor', -6.5971, 106.8060],
      ['Kab. Bogor', -6.4800, 106.8400],
      ['Kota Depok', -6.4025, 106.7942],
      ['Kota Bekasi', -6.2383, 106.9756],
      ['Kab. Bekasi', -6.3600, 107.1700],
      ['Kota Bandung', -6.9175, 107.6191],
      ['Kab. Bandung', -7.0200, 107.5300],
      ['Kab. Bandung Barat', -6.8400, 107.5100],
      ['Kota Cimahi', -6.8722, 107.5425],
      ['Kota Sukabumi', -6.9277, 106.9300],
      ['Kab. Sukabumi', -6.9900, 106.5500],
      ['Kab. Cianjur', -6.8200, 107.1400],
      ['Kab. Karawang', -6.3227, 107.3376],
      ['Kab. Purwakarta', -6.5569, 107.4433],
      ['Kab. Subang', -6.5700, 107.7600],
      ['Kota Cirebon', -6.7320, 108.5523],
      ['Kab. Cirebon', -6.7600, 108.4800],
      ['Kab. Indramayu', -6.3270, 108.3200],
      ['Kab. Majalengka', -6.8364, 108.2278],
      ['Kab. Kuningan', -6.9760, 108.4830],
      ['Kab. Sumedang', -6.8580, 107.9200],
      ['Kab. Garut', -7.2200, 107.9000],
      ['Kota Tasikmalaya', -7.3274, 108.2207],
      ['Kab. Tasikmalaya', -7.3600, 108.1100],
      ['Kab. Ciamis', -7.3260, 108.3530],
      ['Kota Banjar', -7.3700, 108.5400],
      ['Kab. Pangandaran', -7.6840, 108.6500],
    ]],
    ['Jawa Tengah', [
      ['Kota Semarang', -6.9667, 110.4167],
      ['Kab. Semarang', -7.1400, 110.4000],
      ['Kota Surakarta (Solo)', -7.5755, 110.8243],
      ['Kota Salatiga', -7.3305, 110.5084],
      ['Kota Magelang', -7.4797, 110.2177],
      ['Kab. Magelang', -7.5200, 110.2200],
      ['Kota Pekalongan', -6.8898, 109.6746],
      ['Kota Tegal', -6.8694, 109.1402],
      ['Kab. Tegal', -6.9900, 109.1300],
      ['Kab. Brebes', -6.8700, 109.0400],
      ['Kab. Pemalang', -6.8900, 109.3800],
      ['Kab. Banyumas (Purwokerto)', -7.4243, 109.2396],
      ['Kab. Cilacap', -7.7200, 109.0100],
      ['Kab. Purbalingga', -7.3900, 109.3600],
      ['Kab. Kebumen', -7.6700, 109.6500],
      ['Kab. Purworejo', -7.7100, 110.0100],
      ['Kab. Wonosobo', -7.3600, 109.9000],
      ['Kab. Temanggung', -7.3100, 110.1700],
      ['Kab. Kendal', -6.9200, 110.2000],
      ['Kab. Demak', -6.8900, 110.6400],
      ['Kab. Kudus', -6.8048, 110.8405],
      ['Kab. Jepara', -6.5880, 110.6680],
      ['Kab. Pati', -6.7500, 111.0400],
      ['Kab. Rembang', -6.7100, 111.3400],
      ['Kab. Blora', -6.9700, 111.4200],
      ['Kab. Grobogan', -7.0800, 110.9200],
      ['Kab. Klaten', -7.7058, 110.6061],
      ['Kab. Boyolali', -7.5300, 110.6000],
      ['Kab. Sukoharjo', -7.6800, 110.8300],
      ['Kab. Karanganyar', -7.6000, 110.9500],
      ['Kab. Sragen', -7.4200, 111.0200],
      ['Kab. Wonogiri', -7.8100, 110.9200],
    ]],
    ['DI Yogyakarta', [
      ['Kota Yogyakarta', -7.7956, 110.3695],
      ['Kab. Sleman', -7.7160, 110.3550],
      ['Kab. Bantul', -7.8880, 110.3280],
      ['Kab. Kulon Progo', -7.8600, 110.1600],
      ['Kab. Gunungkidul', -7.9660, 110.6020],
    ]],
    ['Jawa Timur', [
      ['Kota Surabaya', -7.2575, 112.7521],
      ['Kab. Sidoarjo', -7.4478, 112.7183],
      ['Kab. Gresik', -7.1560, 112.6550],
      ['Kota Malang', -7.9666, 112.6326],
      ['Kab. Malang', -8.1300, 112.5700],
      ['Kota Batu', -7.8712, 112.5269],
      ['Kota Kediri', -7.8480, 112.0178],
      ['Kab. Kediri', -7.8100, 112.1600],
      ['Kota Blitar', -8.0955, 112.1609],
      ['Kota Madiun', -7.6298, 111.5239],
      ['Kota Mojokerto', -7.4722, 112.4336],
      ['Kota Pasuruan', -7.6453, 112.9075],
      ['Kota Probolinggo', -7.7543, 113.2159],
      ['Kab. Jombang', -7.5450, 112.2330],
      ['Kab. Lamongan', -7.1160, 112.4160],
      ['Kab. Tuban', -6.8970, 112.0650],
      ['Kab. Bojonegoro', -7.1500, 111.8800],
      ['Kab. Tulungagung', -8.0650, 111.9020],
      ['Kab. Ponorogo', -7.8660, 111.4620],
      ['Kab. Jember', -8.1724, 113.6995],
      ['Kab. Banyuwangi', -8.2192, 114.3691],
      ['Kab. Lumajang', -8.1330, 113.2240],
      ['Kab. Bondowoso', -7.9130, 113.8210],
      ['Kab. Situbondo', -7.7060, 114.0090],
      ['Kab. Bangkalan', -7.0450, 112.7350],
      ['Kab. Pamekasan', -7.1560, 113.4740],
      ['Kab. Sumenep', -7.0080, 113.8590],
    ]],
    ['Bali', [
      ['Kota Denpasar', -8.6705, 115.2126],
      ['Kab. Badung', -8.5819, 115.1771],
      ['Kab. Gianyar', -8.5440, 115.3250],
      ['Kab. Tabanan', -8.5410, 115.1250],
      ['Kab. Buleleng (Singaraja)', -8.1120, 115.0880],
      ['Kab. Karangasem', -8.4450, 115.6120],
      ['Kab. Klungkung', -8.5350, 115.4020],
      ['Kab. Jembrana', -8.3600, 114.6400],
      ['Kab. Bangli', -8.4540, 115.3540],
    ]],
    ['Nusa Tenggara Barat', [
      ['Kota Mataram', -8.5833, 116.1167],
      ['Kota Bima', -8.4600, 118.7267],
      ['Kab. Lombok Barat', -8.6800, 116.1200],
      ['Kab. Lombok Tengah', -8.7050, 116.2700],
      ['Kab. Lombok Timur', -8.6500, 116.5300],
      ['Kab. Sumbawa', -8.4930, 117.4200],
      ['Kab. Dompu', -8.5360, 118.4630],
    ]],
    ['Nusa Tenggara Timur', [
      ['Kota Kupang', -10.1772, 123.6070],
      ['Kab. Manggarai Barat (Labuan Bajo)', -8.4964, 119.8877],
      ['Kab. Manggarai', -8.6100, 120.4600],
      ['Kab. Ende', -8.8430, 121.6620],
      ['Kab. Sikka (Maumere)', -8.6190, 122.2120],
      ['Kab. Flores Timur', -8.3430, 122.9800],
      ['Kab. Sumba Timur', -9.6500, 120.2640],
      ['Kab. Belu (Atambua)', -9.1060, 124.8920],
    ]],
    ['Kalimantan Barat', [
      ['Kota Pontianak', -0.0263, 109.3425],
      ['Kota Singkawang', 0.9074, 108.9844],
      ['Kab. Kubu Raya', -0.1200, 109.4000],
      ['Kab. Sambas', 1.3600, 109.3000],
      ['Kab. Ketapang', -1.8500, 109.9800],
      ['Kab. Sintang', 0.0680, 111.4980],
      ['Kab. Sanggau', 0.1330, 110.5900],
    ]],
    ['Kalimantan Tengah', [
      ['Kota Palangka Raya', -2.2136, 113.9108],
      ['Kab. Kotawaringin Timur (Sampit)', -2.5310, 112.9500],
      ['Kab. Kotawaringin Barat (Pangkalan Bun)', -2.6830, 111.6260],
      ['Kab. Kapuas', -3.0080, 114.3870],
      ['Kab. Barito Utara', -0.9500, 114.8900],
    ]],
    ['Kalimantan Selatan', [
      ['Kota Banjarmasin', -3.3186, 114.5944],
      ['Kota Banjarbaru', -3.4420, 114.8310],
      ['Kab. Banjar (Martapura)', -3.4100, 114.8500],
      ['Kab. Tanah Laut', -3.8000, 114.7700],
      ['Kab. Kotabaru', -3.2400, 116.2200],
      ['Kab. Tabalong', -2.1700, 115.3800],
    ]],
    ['Kalimantan Timur', [
      ['Kota Samarinda', -0.5022, 117.1536],
      ['Kota Balikpapan', -1.2379, 116.8529],
      ['Kota Bontang', 0.1333, 117.5000],
      ['Kab. Kutai Kartanegara (Tenggarong)', -0.4400, 116.9900],
      ['Kab. Penajam Paser Utara (IKN)', -1.2400, 116.7100],
      ['Kab. Berau', 2.1500, 117.5000],
      ['Kab. Kutai Timur', 0.5000, 117.5500],
    ]],
    ['Kalimantan Utara', [
      ['Kota Tarakan', 3.3274, 117.5785],
      ['Kab. Bulungan (Tanjung Selor)', 2.8375, 117.3653],
      ['Kab. Nunukan', 4.1350, 117.6500],
      ['Kab. Malinau', 3.5840, 116.6380],
    ]],
    ['Sulawesi Utara', [
      ['Kota Manado', 1.4748, 124.8421],
      ['Kota Bitung', 1.4404, 125.1217],
      ['Kota Tomohon', 1.3236, 124.8400],
      ['Kota Kotamobagu', 0.7330, 124.3160],
      ['Kab. Minahasa', 1.2980, 124.9100],
      ['Kab. Minahasa Utara', 1.4100, 124.9700],
    ]],
    ['Gorontalo', [
      ['Kota Gorontalo', 0.5435, 123.0568],
      ['Kab. Gorontalo', 0.6200, 122.9800],
      ['Kab. Bone Bolango', 0.5500, 123.1600],
    ]],
    ['Sulawesi Tengah', [
      ['Kota Palu', -0.8917, 119.8707],
      ['Kab. Donggala', -0.6800, 119.7400],
      ['Kab. Poso', -1.3960, 120.7530],
      ['Kab. Banggai (Luwuk)', -0.9510, 122.7870],
      ['Kab. Morowali', -2.5400, 121.9700],
      ['Kab. Tolitoli', 1.0380, 120.8180],
    ]],
    ['Sulawesi Barat', [
      ['Kab. Mamuju', -2.6748, 118.8885],
      ['Kab. Polewali Mandar', -3.4320, 119.3430],
      ['Kab. Majene', -3.5400, 118.9700],
    ]],
    ['Sulawesi Selatan', [
      ['Kota Makassar', -5.1477, 119.4327],
      ['Kota Parepare', -4.0135, 119.6255],
      ['Kota Palopo', -2.9925, 120.1969],
      ['Kab. Gowa', -5.2000, 119.4600],
      ['Kab. Maros', -5.0050, 119.5740],
      ['Kab. Bone', -4.5380, 120.3280],
      ['Kab. Bulukumba', -5.5560, 120.1950],
      ['Kab. Tana Toraja', -3.1050, 119.8530],
      ['Kab. Luwu Timur', -2.6300, 121.1500],
    ]],
    ['Sulawesi Tenggara', [
      ['Kota Kendari', -3.9985, 122.5130],
      ['Kota Baubau', -5.4667, 122.6333],
      ['Kab. Konawe', -3.8500, 122.0500],
      ['Kab. Kolaka', -4.0600, 121.5950],
      ['Kab. Muna', -4.8380, 122.7240],
    ]],
    ['Maluku', [
      ['Kota Ambon', -3.6954, 128.1814],
      ['Kota Tual', -5.6300, 132.7500],
      ['Kab. Maluku Tengah', -3.3000, 128.9600],
      ['Kab. Buru', -3.2500, 127.0900],
    ]],
    ['Maluku Utara', [
      ['Kota Ternate', 0.7893, 127.3870],
      ['Kota Tidore Kepulauan', 0.6833, 127.4000],
      ['Kab. Halmahera Utara', 1.7300, 128.0100],
      ['Kab. Halmahera Selatan', -0.6300, 127.4800],
    ]],
    ['Papua', [
      ['Kota Jayapura', -2.5916, 140.6690],
      ['Kab. Jayapura', -2.5700, 140.5100],
      ['Kab. Biak Numfor', -1.1760, 136.0820],
      ['Kab. Kepulauan Yapen', -1.8700, 136.2400],
    ]],
    ['Papua Barat', [
      ['Kab. Manokwari', -0.8615, 134.0620],
      ['Kab. Fakfak', -2.9260, 132.2960],
      ['Kab. Kaimana', -3.6610, 133.7740],
    ]],
    ['Papua Barat Daya', [
      ['Kota Sorong', -0.8762, 131.2558],
      ['Kab. Sorong', -1.0400, 131.3200],
      ['Kab. Raja Ampat', -0.4300, 130.8200],
    ]],
    ['Papua Tengah', [
      ['Kab. Nabire', -3.3667, 135.4960],
      ['Kab. Mimika (Timika)', -4.5467, 136.8833],
    ]],
    ['Papua Pegunungan', [
      ['Kab. Jayawijaya (Wamena)', -4.0980, 138.9490],
    ]],
    ['Papua Selatan', [
      ['Kab. Merauke', -8.4932, 140.4018],
      ['Kab. Boven Digoel', -6.0900, 140.3000],
    ]],
  ];

  const PROVINCES = RAW_PROVINCES.map(([name, cities]) => ({
    name,
    cities: cities.map(([cityName, lat, lng]) => ({ name: cityName, lat, lng })),
  }));

  function normalizeText(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  function findCity(provinceName, cityName) {
    const cleanCity = normalizeText(cityName);
    if (!cleanCity) return null;
    const cleanProv = normalizeText(provinceName);
    const pool = cleanProv
      ? PROVINCES.filter((p) => normalizeText(p.name) === cleanProv)
      : PROVINCES;
    for (const prov of (pool.length ? pool : PROVINCES)) {
      const hit = prov.cities.find((c) => normalizeText(c.name) === cleanCity);
      if (hit) return { province: prov.name, city: hit.name, lat: hit.lat, lng: hit.lng };
    }
    return null;
  }

  // Proyeksi koordinat Indonesia (lat, lng) ke persentase (left%, top%) pada SVG peta titik 960x380.
  // Dikalibrasi agar titik Bogor (-6.59, 106.79) tepat di (25.82%, 72.03%) dan seluruh pulau sejajar dengan grid titik.
  function projectToMap(lat, lng) {
    const nLat = Number(lat);
    const nLng = Number(lng);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLng)) return null;
    const scale = 20.509442;
    const x = -1942.3313 + scale * nLng;
    const y = 138.5568 - scale * nLat;
    const left = Math.max(1.5, Math.min(98.5, (x / 960) * 100));
    const top = Math.max(4, Math.min(96, (y / 380) * 100));
    return { left, top };
  }

  root.SIGI_LOCATIONS = {
    LEVELS,
    PROVINCES,
    findCity,
    projectToMap,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
