#!/usr/bin/env node
/*
 * admin/serve.js — OPTIONAL local preview of the admin dashboard.
 *
 * You do NOT need this anymore: the dashboard is hosted in the repo itself and
 * runs straight from GitHub Pages at
 *     https://<owner>.github.io/<repo>/admin/
 * (open that URL, paste your fine-grained PAT once, it is kept only in your
 *  browser's localStorage).
 *
 * This tiny server exists only if you want to try the page offline on your own
 * machine before pushing:   npm run admin   →  http://127.0.0.1:8787/admin/
 * It binds to 127.0.0.1 only and simply serves the files; all GitHub calls go
 * from your browser directly to api.github.com.
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

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return send(res, 403, 'forbidden', 'text/plain');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, 'not found', 'text/plain');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

const URL_ = `http://${HOST}:${PORT}/admin/`;
const server = http.createServer(serveStatic);
server.listen(PORT, HOST, () => {
  console.log('\n  ✔ Admin dashboard preview (local only): ' + URL_);
  console.log('  Note: the real dashboard works without Node at your GitHub Pages URL:\n      https://<owner>.github.io/<repo>/admin/\n');
  try {
    if (process.platform === 'darwin') execFileSync('open', [URL_]);
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', URL_]);
    else execFileSync('xdg-open', [URL_], { stdio: 'ignore' });
  } catch (_) { console.log('  (Open the URL above manually.)\n'); }
});
