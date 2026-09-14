# fingerprint-api

REST API untuk menarik log absensi dari **beberapa** mesin fingerprint **Solution**
(protokol ZKTeco) sekaligus, dan mengembalikannya sebagai satu JSON gabungan
dengan filter rentang tanggal/waktu.

Diuji langsung terhadap dua mesin: `192.168.1.210` berisi 145.429 log / 469 karyawan,
dan `192.168.1.211` berisi 50.210 log / 829 karyawan.

## Fitur

- **Banyak mesin dalam satu API.** Log dari semua terminal digabung, diurutkan, dan
  bisa disaring per mesin dengan `deviceId`.
- Filter rentang tanggal & jam, filter per `userId`, pencarian nama, paginasi, urutan asc/desc.
- Endpoint rekap harian: jam masuk pertama dan jam pulang terakhir per karyawan per tanggal,
  tetap benar walau karyawan masuk lewat satu gerbang dan pulang lewat gerbang lain.
- Log lengkap dengan metode verifikasi (sidik jari / password / kartu) dan status in/out,
  yang tidak diekspos oleh `node-zklib` bawaan.
- Cache tersimpan di disk, satu berkas per mesin. Restart tidak perlu unduh ulang,
  dan hasil sinkronisasi yang terputus tetap terakumulasi.
- Sinkronisasi terjadwal di latar belakang dan berjalan paralel ke semua mesin,
  sehingga tidak ada request yang menunggu unduhan.
- Satu mesin mati tidak menjatuhkan yang lain. Respons tetap keluar dari mesin
  yang hidup, dengan penanda bahwa datanya belum lengkap.
- Mode `excel` untuk uji coba tanpa terhubung ke mesin, membaca file export
  Attendance Management Solution.

## Instalasi

```bash
npm install
cp .env.example .env
```

Daftarkan mesin di [devices.json](devices.json), lalu:

```bash
npm start                          # produksi
npm run dev                        # dengan nodemon
npm run check:device               # cek semua mesin sekaligus
npm run check:device -- mesin-2    # cek satu mesin saja
```

## Docker

```bash
cp .env.example .env        # wajib, .env tidak ikut ke image
docker compose up -d --build
curl http://localhost:3017/health
```

Service dipetakan ke port **3017** di host. Di dalam container tetap 3000, dan
nilainya dikunci di `docker-compose.yml` supaya pemetaan tidak rusak kalau `.env`
disunting.

Dua volume yang penting:

| Volume | Alasan |
| --- | --- |
| `fingerprint-data:/app/data` | Cache per mesin. Tanpa ini setiap restart mengunduh ulang ratusan ribu log |
| `./devices.json:/app/devices.json:ro` | Daftar mesin bisa disunting dari host tanpa membangun ulang image |

Cache sengaja memakai named volume, bukan bind mount `./data`. Folder `data/`
di-gitignore sehingga tidak ada setelah clone. Docker akan membuatnya sebagai
milik root, padahal container berjalan sebagai user `node`, sehingga cache gagal
ditulis tanpa error yang terlihat dan setiap restart mengunduh ulang semuanya.
Named volume mewarisi kepemilikan dari image sehingga langsung bisa ditulis.

Untuk memeriksa atau mengosongkan cache:

```bash
docker volume inspect fingerprint-data
docker compose down && docker volume rm fingerprint-data
```

Setelah menyunting `devices.json` di host, terapkan dengan
`curl -X POST http://localhost:3017/api/v1/devices/reload`. Sebagian editor
menyimpan berkas dengan cara mengganti berkas lama, bukan menimpanya. Bila itu
terjadi, bind mount masih menunjuk berkas lama dan perubahan tidak terlihat.
Jalankan `docker compose restart fingerprint-api` sebagai gantinya.

**Zona waktu wajib benar.** Alpine tidak membawa basis data zona waktu, jadi
`Dockerfile` memasang `tzdata`. Tanpa paket itu `TZ=Asia/Jakarta` diam-diam
jatuh ke UTC dan setiap jam absensi bergeser 7 jam tanpa error apa pun.
Pastikan `GET /health` melaporkan `"timezone": "Asia/Jakarta"`.

**Container harus bisa menjangkau mesin fingerprint.** Jaringan bridge bawaan
Docker meneruskan koneksi keluar ke LAN, jadi biasanya langsung jalan. Kalau
`/api/v1/devices/info` melaporkan semua mesin `reachable: false` padahal dari
host bisa, ganti jaringannya dengan `network_mode: host` dan hapus blok `ports`.

**Jalankan satu instance saja.** Tiap instance punya scheduler sendiri dan akan
menarik mesin yang sama secara terpisah. Bila nanti ada beberapa replika, matikan
scheduler di semua kecuali satu lewat `SYNC_ENABLED=false`.

Diagnostik di dalam container:

```bash
docker compose exec fingerprint-api npm run check:device
docker compose logs -f fingerprint-api
```

## Mesin fingerprint

Semua terminal didaftarkan di [devices.json](devices.json). IP dan port tidak
lagi ditanam di kode maupun di satu variabel `.env`.

```json
{
  "devices": [
    { "id": "mesin-1", "name": "Gerbang Depan", "ip": "192.168.1.210", "port": 4370, "enabled": true },
    { "id": "mesin-2", "name": "Gerbang Belakang", "ip": "192.168.1.211", "port": 4370, "enabled": true },
    { "id": "mesin-3", "name": "Gudang", "ip": "192.168.1.212", "port": 4370, "enabled": false }
  ]
}
```

| Field | Wajib | Keterangan |
| --- | --- | --- |
| `ip` | ya | Alamat mesin |
| `id` | tidak | Dipakai di parameter `deviceId` dan nama berkas cache. Dibuat dari `name` atau `ip` bila kosong |
| `name` | tidak | Label yang muncul di respons |
| `port` | tidak | Default `4370` |
| `enabled` | tidak | Isi `false` untuk melewati mesin tanpa menghapus barisnya |
| `timeout`, `inport`, `chunkTimeoutMs`, `chunkSize`, `chunkRetries` | tidak | Menimpa nilai bawaan dari `.env` untuk mesin ini saja |

Setelah mengubah berkas, terapkan tanpa restart:

```bash
curl -X POST http://localhost:3000/api/v1/devices/reload
```

Berkas yang rusak tidak menjatuhkan service. Daftar lama tetap berlaku dan
pesan kesalahannya dikembalikan di field `error`.

Bila `devices.json` tidak ada sama sekali, `DEVICE_IP` dan `DEVICE_PORT` dari
`.env` dipakai sebagai satu mesin tunggal.

## Postman

Dua berkas siap impor ada di folder [postman/](postman/):

| Berkas | Isi |
| --- | --- |
| `fingerprint-api.postman_collection.json` | 16 request dalam 6 folder, lengkap dengan tes otomatis |
| `fingerprint-api.postman_environment.json` | Variabel `baseUrl` |

Cara pakai: **Import**, pilih kedua berkas, lalu aktifkan environment
**fingerprint-api - Local** di pojok kanan atas.

Dua hal berjalan otomatis:

- Variabel `start` dan `end` terisi sendiri ke tanggal 1 bulan berjalan sampai hari ini
  bila kamu belum mengisinya, jadi setiap request bisa langsung dijalankan.
- Request **Daftar karyawan** menyimpan satu `userId` ke variabel collection, sehingga
  request yang memfilter per karyawan langsung punya nilai yang valid.

Jalankan folder secara berurutan, atau tekan **Run collection**. Permintaan pertama
memicu unduhan penuh dari mesin dan memakan sekitar satu menit, jadi pastikan
Request timeout di Postman Settings tidak dibatasi di bawah 120 detik.

Koleksi ini juga bisa dijalankan di terminal atau CI dengan Newman:

```bash
npx newman run postman/fingerprint-api.postman_collection.json \
  -e postman/fingerprint-api.postman_environment.json \
  --timeout-request 300000
```

## Konfigurasi

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP |
| `DATA_SOURCE` | `device` | `device` (mesin) atau `excel` (file export, untuk uji coba) |
| `DEVICES_FILE` | `./devices.json` | Daftar mesin fingerprint |
| `DEVICE_IP` | `192.168.1.210` | Dipakai hanya bila `devices.json` tidak ada |
| `DEVICE_PORT` | `4370` | Port bawaan untuk mesin yang tidak menyebutkannya |
| `DEVICE_CHUNK_TIMEOUT` | `20000` | Batas tunggu per potongan data, dalam milidetik |
| `DEVICE_CHUNK_SIZE` | `65472` | Ukuran potongan unduhan, maksimal 65472 |
| `DEVICE_CHUNK_RETRIES` | `2` | Percobaan ulang per potongan sebelum menyerah |
| `EXCEL_FILE` | `./Sample Absensi.xls` | Berkas export yang dibaca saat `DATA_SOURCE=excel`. Berkas harus ada, kalau tidak semua endpoint data membalas kode 502 |
| `CACHE_TTL_SECONDS` | `300` | Umur cache sebelum dianggap basi |
| `CACHE_PERSIST` | `true` | Simpan cache ke disk |
| `CACHE_DIR` | `./data` | Cache disimpan di `<CACHE_DIR>/devices/<id>.json`, satu berkas per mesin |
| `SYNC_ENABLED` | `true` | Sinkronisasi terjadwal di latar belakang |
| `SYNC_INTERVAL_SECONDS` | `300` | Jeda antar sinkronisasi, dihitung setelah yang sebelumnya selesai |
| `SYNC_INITIAL_DELAY_SECONDS` | `2` | Jeda sebelum sinkronisasi pertama setelah server hidup |
| `DEFAULT_PAGE_SIZE` | `1000` | Nilai `limit` bila tidak dikirim |
| `MAX_PAGE_SIZE` | `10000` | Batas atas `limit` |
| `TZ` | `Asia/Jakarta` | **Wajib sama dengan zona waktu mesin** |

Tidak ada autentikasi di API ini. Tidak ada login, tabel user, JWT, session,
maupun API key. Semua endpoint terbuka, jadi jalankan service ini hanya di
jaringan yang kamu percaya, atau taruh di belakang reverse proxy yang menangani
akses.

## Endpoint

Semua respons memakai amplop yang sama:

```json
{ "code": 200, "success": true, "meta": { }, "data": [ ] }
```

### `GET /health`

Status service, sumber data aktif, zona waktu proses, kondisi cache, dan jadwal
sinkronisasi berikutnya. Dijawab murni dari memori, jadi tetap secepat kilat
walaupun sinkronisasi sedang berjalan.

```json
{
  "status": "ok",
  "source": "device",
  "device": "192.168.1.210:4370",
  "timezone": "Asia/Jakarta",
  "uptimeSeconds": 184,
  "cache": {
    "totalRecords": 195639,
    "totalUsers": 1019,
    "totalDevices": 3,
    "devicesOnline": 2,
    "complete": false,
    "pending": ["mesin-3"],
    "syncing": false,
    "devices": [
      { "deviceId": "mesin-1", "synced": true, "totalRecords": 145429, "lastSyncAt": "2026-09-11 09:15:54", "lastError": null },
      { "deviceId": "mesin-2", "synced": true, "totalRecords": 50210, "lastSyncAt": "2026-09-11 09:15:14", "lastError": null },
      { "deviceId": "mesin-3", "synced": false, "totalRecords": 0, "lastSyncAt": null, "lastError": "connect ETIMEDOUT 192.168.1.212:4370" }
    ]
  },
  "scheduler": {
    "enabled": true,
    "intervalSeconds": 300,
    "runCount": 2,
    "lastRunAt": "2026-09-11 09:15:54",
    "nextRunAt": "2026-09-11 09:20:54",
    "lastError": "mesin-3: connect ETIMEDOUT 192.168.1.212:4370"
  }
}
```

Untuk monitoring, pantau `cache.devicesOnline` terhadap `cache.totalDevices`,
lalu `cache.devices[].lastError` untuk tahu mesin mana yang bermasalah. Saat
sinkronisasi sedang berjalan, `scheduler.nextRunAt` bernilai `null` dan
`cache.syncing` bernilai `true`.

### `GET /api/v1/attendance`

Log absensi mentah.

| Query | Contoh | Keterangan |
| --- | --- | --- |
| `start` | `2026-09-01` atau `2026-09-01 08:00:00` | Awal rentang. Tanpa jam berarti `00:00:00` |
| `end` | `2026-09-10` atau `10/09/2026 17:00` | Akhir rentang. Tanpa jam berarti `23:59:59` |
| `userId` | `200` atau `200,201,238` | Filter satu atau beberapa No.ID |
| `deviceId` | `mesin-1` atau `mesin-1,mesin-2` | Filter per mesin. Kosong berarti semua mesin |
| `name` | `surianto` | Pencarian nama, tidak peka huruf besar/kecil |
| `order` | `asc` \| `desc` | Urutan waktu, default `asc` |
| `page` | `1` | Halaman, dimulai dari 1 |
| `limit` | `1000` | Jumlah baris per halaman |
| `refresh` | `true` | Paksa tarik ulang dari mesin, abaikan cache |

Tanpa `start` dan `end`, rentang otomatis diisi **hari ini**.

```bash
curl "http://localhost:3000/api/v1/attendance?start=2026-09-01&end=2026-09-10&userId=118060054"
```

```json
{
  "code": 200,
  "success": true,
  "meta": {
    "start": "2026-09-01 00:00:00",
    "end": "2026-09-10 23:59:59",
    "userId": ["118060054"],
    "deviceId": null,
    "order": "asc",
    "page": 1,
    "limit": 1000,
    "count": 20,
    "total": 20,
    "totalPages": 1,
    "source": "device",
    "complete": true,
    "pendingDevices": [],
    "devices": [
      { "deviceId": "mesin-1", "synced": true, "lastSyncAt": "2026-09-11 09:15:54", "warning": null, "error": null },
      { "deviceId": "mesin-2", "synced": true, "lastSyncAt": "2026-09-11 09:15:14", "warning": null, "error": null }
    ]
  },
  "data": [
    {
      "uid": 13967,
      "userId": "118060054",
      "name": "MArzeinlubis",
      "department": null,
      "timestamp": "2026-09-10 00:05:51",
      "date": "2026-09-10",
      "time": "00:05:51",
      "verifyMode": 1,
      "verify": "Sidik Jari",
      "state": 1,
      "status": "Check Out",
      "deviceId": "mesin-1",
      "deviceName": "Gerbang Depan",
      "deviceIp": "192.168.1.210"
    }
  ]
}
```

`meta.complete` bernilai `false` selama masih ada mesin aktif yang belum pernah
tersinkronisasi, dan `meta.pendingDevices` menyebut mesin mana. Pakai itu untuk
membedakan hasil yang memang kosong dari hasil yang belum lengkap.

### `GET /api/v1/attendance/daily`

Rekap satu baris per karyawan per tanggal. Query sama dengan endpoint di atas.

```json
{
  "userId": "118060054",
  "name": "MArzeinlubis",
  "date": "2026-09-10",
  "checkIn": "00:05:51",
  "checkOut": "14:46:22",
  "totalScan": 2,
  "durationMinutes": 881,
  "punches": ["00:05:51", "14:46:22"],
  "deviceIds": ["mesin-1", "mesin-2"]
}
```

Pengelompokan sengaja mengabaikan mesin mana yang merekam. Karyawan yang masuk
lewat satu gerbang lalu pulang lewat gerbang lain tetap menghasilkan satu baris
yang benar, dan `deviceIds` menyebut mesin mana saja yang terlibat.

`checkOut` dan `durationMinutes` bernilai `null` bila karyawan hanya scan sekali pada
tanggal tersebut.

### `GET /api/v1/employees`

Daftar karyawan dari semua mesin: `uid`, `userId`, `name`, `role`, `cardNo`, dan
`deviceIds` berisi mesin tempat orang itu terdaftar. Satu karyawan yang terdaftar
di beberapa mesin tetap muncul sebagai satu baris.

Tambahkan `?deviceId=mesin-1` untuk menyaring per mesin, atau `?refresh=true`
untuk menarik ulang.

### `GET /api/v1/devices`

Daftar mesin terkonfigurasi beserta kondisi cache dan sinkronisasinya. Dijawab
dari memori, tidak menyentuh jaringan sama sekali.

### `GET /api/v1/devices/info`

Menghubungi setiap mesin aktif secara paralel dan melaporkan jumlah user, jumlah
log, serta kapasitasnya. Mesin yang tidak bisa dihubungi muncul dengan
`reachable: false` dan pesan kesalahannya, bukan menggagalkan seluruh request.

```json
{
  "meta": { "total": 3, "reachable": 2 },
  "data": [
    { "deviceId": "mesin-1", "ip": "192.168.1.210", "reachable": true, "userCounts": 469, "logCounts": 145429, "logCapacity": 200000 },
    { "deviceId": "mesin-2", "ip": "192.168.1.211", "reachable": true, "userCounts": 829, "logCounts": 50210, "logCapacity": 200000 },
    { "deviceId": "mesin-3", "ip": "192.168.1.212", "reachable": false, "error": "connect ETIMEDOUT 192.168.1.212:4370 (ETIMEDOUT)" }
  ]
}
```

### `POST /api/v1/devices/reload`

Membaca ulang `devices.json` supaya mesin bisa ditambah, dipindah alamat, atau
dinonaktifkan tanpa restart. Hanya berkas lokal yang dibaca. Tidak ada bagian
dari daftar mesin yang bisa disetel lewat isi request, jadi endpoint ini tidak
bisa dipakai untuk mengarahkan service ke alamat sembarangan.

### `POST /api/v1/cache/refresh`

Memaksa unduh ulang penuh dari semua mesin aktif dan melaporkan hasilnya per
mesin. Butuh sekitar satu menit karena semua mesin ditarik paralel.

## Catatan teknis

**Mesin tidak bisa memfilter tanggal.** Protokol ZKTeco hanya menyediakan perintah
"kirim semua log". Seluruh buffer harus diunduh lalu difilter di sisi API. Itulah
alasan adanya cache: unduhan pertama memakan sekitar 52 detik untuk 145 ribu log
(5,8 MB), permintaan berikutnya dijawab dari memori dalam waktu di bawah 100 ms.

**Tidak ada request yang menunggu unduhan.** Dua mekanisme menjaga hal ini.
Scheduler di [scheduler.js](src/services/scheduler.js) menyegarkan cache di latar
belakang menurut jadwalnya sendiri. Di samping itu, begitu cache terisi, request
selalu dijawab dari cache saat itu juga dan penyegaran berjalan di belakang,
walaupun cache sudah lewat masa berlakunya. Hanya request paling pertama pada
cache yang benar-benar kosong yang perlu menunggu.

Pengukuran pada mesin live selama 150 detik, mencakup dua sinkronisasi latar
belakang, memberi latensi request terlambat 37 ms. Pakai `?refresh=true` bila
kamu memang butuh data yang dijamin baru dan bersedia menunggu.

Sinkronisasi berjalan satu per satu. Bila jadwal dan permintaan manual kebetulan
berbarengan, keduanya berbagi satu unduhan yang sama, tidak pernah menumpuk.

**Unduhan dilakukan sekuensial.** `node-zklib` mengirim seluruh permintaan potongan
sekaligus. Pada mesin dengan ratusan ribu log, firmware kewalahan dan transfer
putus di tengah dengan pesan `TIME OUT !! n PACKETS REMAIN` sehingga data terbaru
tidak ikut terbawa. Modul [reader.js](src/zk/reader.js) meminta satu potongan,
menunggu sampai utuh, baru meminta berikutnya. Hasilnya lengkap dan justru
lebih cepat.

**Zona waktu.** Mesin menyimpan waktu polos tanpa offset. Semua timestamp
diperlakukan sebagai waktu lokal dan diformat `YYYY-MM-DD HH:mm:ss`, tidak pernah
dikonversi ke UTC. Jalankan proses dengan `TZ` yang sama dengan setelan jam mesin.

**Label verifikasi.** Angka `verifyMode` dan `state` dikembalikan apa adanya di
samping labelnya, karena penomoran berbeda antar seri firmware. Sesuaikan tabel di
[decode.js](src/zk/decode.js) bila label pada mesin Anda berbeda.

**Satu sesi per mesin, bukan satu sesi global.** Sebuah terminal hanya melayani
satu koneksi kontrol, jadi akses ke mesin yang sama diantrekan. Tapi tiga mesin
adalah tiga percakapan TCP yang terpisah, sehingga ditarik bersamaan. Sinkronisasi
dua mesin berisi 145 ribu dan 50 ribu log selesai dalam 21 detik, bukan
penjumlahan waktu keduanya.

**Kegagalan satu mesin berhenti di mesin itu.** Setiap terminal punya snapshot,
berkas cache, dan status kesalahan sendiri. Mesin yang mati hanya membuat
`meta.complete` bernilai `false` dan namanya masuk `meta.pendingDevices`. Data
dari mesin lain tetap keluar seperti biasa.

**Pemakaian memori.** Seluruh log disimpan di memori agar filter rentang cepat.
Dua mesin berisi 195 ribu log memakai sekitar 150 MB. Untuk armada yang jauh
lebih besar, naikkan batas heap Node lewat `--max-old-space-size`.

## Struktur

```
devices.json                   Daftar mesin fingerprint
postman/                       Koleksi dan environment siap impor
data/devices/<id>.json         Cache per mesin
src/
├── app.js                     Express app dan pemasangan route
├── server.js                  Bootstrap HTTP
├── config.js                  Pembacaan .env
├── devices.js                 Registry mesin, validasi, dan reload
├── middleware/
│   └── errorHandler.js        Amplop error seragam
├── routes/attendance.js       Definisi endpoint
├── services/
│   ├── attendance.js          Cache, filter rentang, rekap harian
│   └── scheduler.js           Sinkronisasi terjadwal di latar belakang
├── sources/excel.js           Sumber offline dari file export
├── store/snapshotStore.js     Cache disk dan penggabungan inkremental
├── utils/                     Tanggal, parser query, kelas error
└── zk/
    ├── client.js              Sesi ke mesin
    ├── reader.js              Unduhan chunk sekuensial
    └── decode.js              Pembacaan record 40 byte
```

## Troubleshooting

Langkah pertama selalu sama: `GET /api/v1/devices/info` untuk tahu mesin mana
yang bisa dihubungi, lalu `GET /health` untuk melihat kondisi cache tiap mesin.

| Gejala | Penanganan |
| --- | --- |
| Satu mesin `reachable: false` dengan `ETIMEDOUT` | Cek IP-nya di `devices.json` dan pastikan server satu jaringan dengan mesin itu. Mesin lain tetap jalan |
| `meta.complete` selalu `false` | Ada mesin aktif yang belum pernah sync. Lihat `meta.pendingDevices`, lalu periksa mesin itu di `/api/v1/devices/info` |
| Mesin sudah diperbaiki tapi belum masuk | `POST /api/v1/devices/reload` lalu `POST /api/v1/cache/refresh` |
| `EADDRINUSE` | Ada proses lain memakai `inport` mesin tersebut. Isi `inport` khusus di `devices.json` untuk mesin itu |
| `warning` berisi "Unduhan berhenti di ..." | Naikkan `DEVICE_CHUNK_TIMEOUT`, atau turunkan `DEVICE_CHUNK_SIZE` ke `32768`. Data yang sempat terunduh tetap tersimpan dan sinkronisasi berikutnya melanjutkan |
| Jam log meleset beberapa jam | `TZ` proses berbeda dengan setelan jam salah satu mesin. Samakan jam semua mesin |
| Nama karyawan kosong | Daftar user gagal dibaca. Panggil `GET /api/v1/employees?refresh=true` |
| Log ganda untuk orang yang sama | Normal bila orang itu benar-benar scan di dua mesin. Saring dengan `deviceId`, atau pakai endpoint `daily` yang sudah menggabungkannya |
