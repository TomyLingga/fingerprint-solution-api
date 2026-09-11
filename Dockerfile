# syntax=docker/dockerfile:1

# ---- Tahap 1: pasang dependensi produksi saja ----
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
# npm ci memakai lockfile apa adanya. --omit=dev membuang nodemon yang hanya
# dipakai saat pengembangan.
RUN npm ci --omit=dev

# ---- Tahap 2: image yang dijalankan ----
FROM node:20-alpine AS runner
WORKDIR /app

# Alpine tidak membawa basis data zona waktu. Tanpa tzdata, TZ=Asia/Jakarta
# diam-diam jatuh kembali ke UTC dan SETIAP jam absensi bergeser 7 jam tanpa
# error apa pun. Paket ini wajib, bukan opsional.
RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Asia/Jakarta

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY devices.json ./devices.json

# Cache per mesin ditulis saat runtime, jadi foldernya harus bisa ditulis oleh
# user non-root. Image node sudah menyediakan user "node".
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 3000

# /health dijawab murni dari memori, jadi tetap cepat walaupun sinkronisasi ke
# mesin sedang berjalan. start-period memberi ruang untuk unduhan pertama.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Dijalankan langsung tanpa npm supaya SIGTERM sampai ke proses Node, sehingga
# scheduler.stop() dan server.close() sempat berjalan saat container dihentikan.
CMD ["node", "src/server.js"]
