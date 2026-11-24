/* Pembungkus untuk Vercel. Setiap file di folder api/ memakai server yang sama. */
import { createServer } from 'node:http';
import { cleanKey, configure, handleApi, handleListen, log, oneLine, sendError } from './sigi-api.mjs';

configure({
  readKey: async (name) => cleanKey(process.env[name] || '', name), // diisi di Environment Variables Vercel
  isAllowedHost: (host) => typeof host === 'string' && host !== '',
  originFor: (host) => `https://${host}`,
  needsPassword: true,
});

export function createSigiServer() {
  const server = createServer((req, res) => {
    handleApi(req, res).then((done) => {
      if (!done) sendError(res, 404, 'SIGI_NOT_FOUND', 'Tidak ditemukan.');
    }).catch((error) => {
      log(`Error server: ${oneLine(error.code || error.message)}`);
      sendError(res, 500, 'SIGI_SERVER', 'Server bermasalah.');
    });
  });
  server.on('upgrade', (req, socket, head) => {
    handleListen(req, socket, head).catch(() => socket.destroy());
  });
  return server;
}
