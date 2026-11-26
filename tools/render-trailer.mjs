#!/usr/bin/env node
/*
 * Merekam trailer Sigi (trailer.js) jadi video MP4 1920x1080, 30 fps.
 *
 * Syarat: server Sigi jalan (node server.mjs, port 8123), Google Chrome, dan ffmpeg.
 * Pakai:   node tools/render-trailer.mjs [alamat-server] [file-keluaran]
 * Contoh:  node tools/render-trailer.mjs http://localhost:8123 assets/trailer/sigi-trailer.mp4
 *
 * Cara kerja: Chrome headless dibuka lewat DevTools Protocol. tools/trailer-render.html memakai jam palsu:
 * jam trailer dan semua animasi CSS dimajukan 1/30 detik per frame, lalu difoto. Jadi setiap frame tepat,
 * berapa pun kecepatan komputernya.
 * Tanpa dependensi npm: memakai WebSocket bawaan Node 22+.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const BASE_URL = (process.argv[2] || 'http://localhost:8123').replace(/\/+$/, '');
const OUT = process.argv[3] || 'assets/trailer/sigi-trailer.mp4';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;
const PORT = 9333;
const EXTRA_MS = 1500; // adegan terakhir ditahan sebentar sebelum video selesai

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = await mkdtemp(join(tmpdir(), 'sigi-chrome-'));
const frames = await mkdtemp(join(tmpdir(), 'sigi-frames-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${WIDTH},${HEIGHT}`, '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  let version = null;
  for (let i = 0; i < 50 && !version; i++) {
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
    if (!version) await sleep(200);
  }
  if (!version) throw new Error('Chrome headless tidak bisa dibuka.');

  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const once = (method) => new Promise((resolve) => {
    const fn = (msg) => {
      if (msg.method === method) {
        listeners.splice(listeners.indexOf(fn), 1);
        resolve(msg.params);
      }
    };
    listeners.push(fn);
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });

  const loaded = once('Page.loadEventFired');
  await s('Page.navigate', { url: `${BASE_URL}/tools/trailer-render.html` });
  await loaded;
  // Tunggu font dan SVG maskot selesai dimuat (waktu nyata), baru mulai.
  const ready = await s('Runtime.evaluate', {
    expression: 'document.fonts.ready.then(() => window.SigiTrailer.ready).then(() => !!document.querySelector(".tr-frame"))',
    awaitPromise: true, returnByValue: true,
  });
  if (!ready.result.value) throw new Error('Halaman trailer tidak siap. Cek server dan tools/trailer-render.html.');

  await s('Runtime.evaluate', { expression: 'window.__begin()' });

  const total = Math.ceil(((40000 + EXTRA_MS) / 1000) * FPS);
  const step = 1000 / FPS;
  for (let i = 0; i < total; i++) {
    await s('Runtime.evaluate', { expression: `window.__step(${step})`, awaitPromise: true });
    const shot = await s('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 } });
    await writeFile(join(frames, `${String(i).padStart(5, '0')}.png`), Buffer.from(shot.data, 'base64'));
    if (i % FPS === 0) process.stdout.write(`\rMerekam detik ${i / FPS} dari ${Math.ceil(total / FPS)}...`);
  }
  process.stdout.write('\nMenggabungkan frame jadi MP4...\n');

  await mkdir(dirname(OUT), { recursive: true });
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, '%05d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT,
    ], { stdio: 'inherit' });
    ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg gagal (kode ${code}).`))));
  });
  console.log(`Selesai: ${OUT}`);
} finally {
  try { ws?.close(); } catch { /* abaikan */ }
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  await rm(frames, { recursive: true, force: true }).catch(() => {});
}
