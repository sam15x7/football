#!/usr/bin/env node
/*
 * admin/serve.js — starts the LOCAL admin dashboard (the old "click + paste URL" flow).
 *
 *   npm run admin            (or: node admin/serve.js)
 *
 * Opens http://127.0.0.1:8787 in your browser. From there you:
 *   · paste a fine-grained GitHub token ONCE — it is stored only in this
 *     browser's localStorage (never uploaded anywhere, never committed),
 *   · add channels by filling name + stream URL and clicking "Add channel",
 *   · remove channels with one click,
 *   · see index.html update automatically (regenerated from channels.json).
 *
 * The server binds to 127.0.0.1 only, so nobody else on your network can use it.
 * It talks directly to the GitHub API from YOUR browser; nothing is proxied.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.ADMIN_PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(body);
}

// Serve repo files read-only (so /admin/admin.html and previews of *.html work).
function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return send(res, 403, 'forbidden', 'text/plain');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, 'not found', 'text/plain');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/open-browser') {
    try {
      if (process.platform === 'darwin') execFileSync('open', [`http://${HOST}:${PORT}/admin/admin.html`]);
      else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', `http://${HOST}:${PORT}/admin/admin.html`]);
      else execFileSync('xdg-open', [`http://${HOST}:${PORT}/admin/admin.html`], { stdio: 'ignore' });
    } catch (_) { /* manual open is fine */ }
    return send(res, 200, '{"ok":true}');
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log('\n  ✔ Local admin dashboard running (only you can reach it):');
  console.log('    http://' + HOST + ':' + PORT + '/admin/admin.html\n');
  console.log('  Token stays inside this browser (localStorage). Closing the tab does not delete it;');
  console.log('  use the "Forget token" button in the page to wipe it.\n');
  try {
    if (process.platform === 'darwin') execFileSync('open', [`http://${HOST}:${PORT}/admin/admin.html`]);
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', `http://${HOST}:${PORT}/admin/admin.html`]);
    else execFileSync('xdg-open', [`http://${HOST}:${PORT}/admin/admin.html`], { stdio: 'ignore' });
  } catch (_) {
    console.log('  (Could not auto-open a browser — visit the URL above manually.)\n');
  }
});
