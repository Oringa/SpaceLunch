// Minimal static server for dist/ mounted under a sub-path (default /centrifuge/),
// mirroring a deployment such as https://example.com/centrifuge/ .
// Usage: node scripts/serve-subpath.mjs [port] [basePath]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const port = Number(process.argv[2] ?? 4173);
let base = process.argv[3] ?? '/centrifuge/';
if (!base.endsWith('/')) base += '/';
const root = resolve('dist');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.map': 'application/json', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === base.slice(0, -1)) {
    res.writeHead(301, { Location: base });
    return res.end();
  }
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end(`Not found. The app is served at ${base}`);
  }
  let rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
  const file = normalize(join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const st = await stat(file);
    const target = st.isDirectory() ? join(file, 'index.html') : file;
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Serving dist/ at http://127.0.0.1:${port}${base}`));
