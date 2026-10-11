// Static production server for dist/, mounted under a sub-path (default /centrifuge/).
// Used by `npm start` (e.g. on Railway) and by the browser tests.
//
//   node scripts/serve-subpath.mjs [port] [basePath]
//   env: PORT (Railway sets it), BASE_PATH (default /centrifuge/),
//        HOST (default: all interfaces, IPv4 + IPv6, when PORT is set; 127.0.0.1 otherwise)
//
// - "/" redirects to the base path; "/healthz" answers 200 for health checks.
// - Hashed assets are cached for a year; index.html is never cached.
// - Text assets are gzip/brotli-compressed once and kept in memory.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { gzipSync, brotliCompressSync } from 'node:zlib';

const port = Number(process.env.PORT ?? process.argv[2] ?? 4173);
// Without a host, Node listens on '::' (dual-stack) where available, else 0.0.0.0.
const host = process.env.HOST ?? (process.env.PORT ? undefined : '127.0.0.1');
let base = process.env.BASE_PATH ?? process.argv[3] ?? '/centrifuge/';
if (!base.startsWith('/')) base = '/' + base;
if (!base.endsWith('/')) base += '/';
const root = resolve('dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.map': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.map', '.txt']);
const cache = new Map();

async function load(file) {
  if (cache.has(file)) return cache.get(file);
  const body = await readFile(file);
  const ext = extname(file);
  const entry = { body, type: TYPES[ext] ?? 'application/octet-stream' };
  if (COMPRESSIBLE.has(ext) && body.length > 1024) {
    entry.gzip = gzipSync(body, { level: 9 });
    entry.br = brotliCompressSync(body);
  }
  cache.set(file, entry);
  return entry;
}

const server = createServer((req, res) => {
  // A bad request must never take the process down.
  handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
server.listen(port, host, () => {
  const a = server.address();
  const shown = typeof a === 'object' && a ? `${a.family === 'IPv6' ? `[${a.address}]` : a.address}:${a.port}` : String(a);
  console.log(`CENTRIFUGE: serving dist/ at http://${shown}${base}`);
});

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (base !== '/' && (url.pathname === '/' || url.pathname === base.slice(0, -1))) {
    res.writeHead(302, { Location: base });
    return res.end();
  }
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`Not found. CENTRIFUGE is served at ${base}`);
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
  } catch {
    res.writeHead(400);
    return res.end();
  }
  let file = normalize(join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const st = await stat(file);
    if (st.isDirectory()) file = join(file, 'index.html');
    const e = await load(file);
    const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css|map)$/.test(file);
    const headers = {
      'Content-Type': e.type,
      'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Accept-Encoding',
    };
    const accept = String(req.headers['accept-encoding'] ?? '');
    let body = e.body;
    if (e.br && /\bbr\b/.test(accept)) {
      body = e.br;
      headers['Content-Encoding'] = 'br';
    } else if (e.gzip && /\bgzip\b/.test(accept)) {
      body = e.gzip;
      headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = String(body.length);
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}
