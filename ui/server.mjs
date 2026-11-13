import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listBooks, loadBook } from './data.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJson(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(body);
}

function sendFile(response, file) {
  if (!fs.existsSync(file)) { response.writeHead(404); response.end('not found'); return; }
  response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(response);
}

/** 只读的本地预览服务：不做任何写操作，语料改了刷新页面即可。 */
export function startServer({ root, port = 4173, host = '127.0.0.1' } = {}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', `http://${request.headers.host}`);

    if (url.pathname === '/api/books') {
      sendJson(response, listBooks(root));
      return;
    }
    if (url.pathname.startsWith('/api/book/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/book/'.length));
      const book = loadBook(root, id);
      if (!book) { sendJson(response, { error: 'not found' }, 404); return; }
      sendJson(response, book);
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      sendFile(response, path.join(here, 'index.html'));
      return;
    }
    const asset = path.join(here, path.basename(url.pathname));
    if (fs.existsSync(asset)) { sendFile(response, asset); return; }

    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({ server, url: `http://${host}:${port}`, close: () => server.close() });
    });
  });
}
