/* admin/lib.js — shared helpers for the backend channel-admin scripts.
 *
 * These scripts are PRIVATE ADMIN TOOLS. They run on your machine (or in a
 * GitHub Actions workflow with your encrypted token) — never in a visitor's
 * browser. The public index.html only renders channels; it has no "add" form.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_FILE = path.join(ROOT, 'template.html');
const INDEX_FILE = path.join(ROOT, 'index.html');
const CHANNELS_FILE = path.join(ROOT, 'channels.json');
const VAULT_FILE = path.join(ROOT, 'admin', 'token.enc'); // git-ignored
const PLAINTEXT_FILE = path.join(ROOT, '.github-token');  // git-ignored

const RESERVED = ['index.html', 'template.html'];

/* ------------------------------- small utils ------------------------------- */

function fail(msg) {
  console.error('\n  ✗ ' + msg + '\n');
  process.exit(1);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function hrefFor(fileName) {
  return encodeURI(fileName);
}

// skynewsitaly -> skynewsitaly.html ; keeps letters, digits, dots, dashes, parens.
function slug(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/\.html?$/i, '')
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9._()\-]/g, '')
    .toLowerCase();
  if (!s) fail('Channel name is empty after cleaning. Use letters and digits, e.g. "skynewsitaly".');
  if (/^[.\-_()]/.test(s)) fail('Channel name cannot start with . - _ or ( : "' + raw + '"');
  return s + '.html';
}

// Sonyten1 -> "Sony Ten 1"
function pretty(fileName) {
  const base = fileName.replace(/\.html$/i, '');
  let out = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// Boolean flags (never consume the next argument) vs value flags.
const BOOL_FLAGS = new Set(['dry-run', 'force', 'no-push', 'no-index', 'check',
                             'list', 'sync', 'relink', 'rotate']);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (BOOL_FLAGS.has(key) || next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

/* ------------------------ encrypted token vault (AES-256-GCM) ---------------
 * setup-token.js writes admin/token.enc:
 *     [16B scrypt salt][12B GCM iv][16B auth tag][ciphertext]
 * The .enc file holds NO secret without the passphrase. The passphrase itself
 * is never stored anywhere: you type it each time an admin script needs the
 * token — or export GH_TOKEN / GITHUB_TOKEN to skip decryption entirely.
 * --------------------------------------------------------------------------- */

// scrypt cost params kept moderate so unlocking the vault stays instant.
const SCRYPT_N = 2 ** 14, SCRYPT_R = 8, SCRYPT_P = 1;

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2
  });
}

function encryptToken(token, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ct]);
}

function decryptToken(buf, passphrase) {
  if (buf.length < 16 + 12 + 16 + 1) {
    fail('Encrypted vault file looks corrupted (too short). Re-run: node admin/setup-token.js --rotate');
  }
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const ct = buf.subarray(44);
  const key = deriveKey(passphrase, salt);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (_) {
    fail('Could not decrypt admin/token.enc — wrong passphrase (or the vault was replaced). Run: node admin/setup-token.js --rotate');
  }
}

/* ------------------------------ token lookup ------------------------------- */

// Priority: GH_TOKEN/GITHUB_TOKEN env → plain .github-token file → encrypted vault.
async function getToken() {
  const envTok = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (envTok) return envTok;

  if (fs.existsSync(PLAINTEXT_FILE)) {
    const t = fs.readFileSync(PLAINTEXT_FILE, 'utf8').trim();
    if (t) return t;
  }

  if (fs.existsSync(VAULT_FILE)) {
    const passphrase = await readPassphraseFromTTY('Vault passphrase (admin/token.enc): ');
    return decryptToken(fs.readFileSync(VAULT_FILE), passphrase).trim();
  }

  fail(
    'No GitHub token found. Options:\n' +
    '  1. node admin/setup-token.js            (stores it ENCRYPTED in admin/token.enc)\n' +
    '  2. export GH_TOKEN=github_pat_...        (or put it in the ignored .github-token file)'
  );
}

// Read a hidden line from the terminal without extra npm dependencies.
function readPassphraseFromTTY(prompt) {
  return new Promise((resolve, reject) => {
    // Env fallback first (works in CI and non-interactive shells).
    const envPass = process.env.GH_PASSPHRASE;
    if (envPass) return resolve(envPass);

    if (!process.stdin.isTTY) {
      return reject(new Error('Not a TTY and GH_PASSPHRASE is not set.'));
    }
    const stdin = process.stdin, stdout = process.stdout;
    let buf = '', ended = false;
    stdout.write(prompt);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = ch => {
      if (ch === '\u0003') { done(); stdout.write('\n'); process.exit(130); }
      else if (ch === '\r' || ch === '\n') { done(); stdout.write('\n'); resolve(buf); }
      else if (ch === '\u007F' || ch === '\b') { buf = buf.slice(0, -1); }
      else if (ch >= ' ') { buf += ch; }
    };
    const done = () => {
      if (ended) return; ended = true;
      stdin.removeListener('data', onData);
      stdin.setRawMode(false); stdin.pause();
    };
    stdin.on('data', onData);
  });
}

/* --------------------------------- config ---------------------------------- */

function readChannelsJson() {
  let data = {};
  if (fs.existsSync(CHANNELS_FILE)) {
    try { data = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')); }
    catch (e) { fail('channels.json is not valid JSON: ' + e.message); }
  }
  return data;
}

function writeChannelsJson(data) {
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2) + '\n');
}

function getRepoConfig() {
  const data = readChannelsJson();
  let owner = data.owner || '', repo = data.repo || '', branch = data.branch || 'main';
  if ((!owner || !repo) && fs.existsSync(path.join(ROOT, '.git'))) {
    try {
      const url = execFileSync('git', ['-C', ROOT, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
      const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/i.exec(url);
      if (m) { owner = owner || m[1]; repo = repo || m[2]; }
    } catch (_) { /* no remote configured — channels.json must carry the values */ }
  }
  if (!owner || !repo) fail('Set "owner" and "repo" in channels.json (or add a GitHub remote to this clone).');
  return { owner, repo, branch, data };
}

/* ---------------------------- local file builders --------------------------- */

function loadTemplate() {
  if (!fs.existsSync(TEMPLATE_FILE)) fail('template.html is missing from ' + ROOT + '.');
  const tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  for (const token of ['{{TITLE}}', '{{STREAM_URL}}']) {
    if (!tpl.includes(token)) fail('template.html no longer contains ' + token + '. Keep those placeholders intact.');
  }
  return tpl;
}

// Same channel structure as before: template.html with {{TITLE}}/{{STREAM_URL}} filled.
function buildPage(title, streamUrl) {
  if (/[{}]/.test(streamUrl)) fail('Stream URL may not contain { or } characters.');
  const tpl = loadTemplate();
  return tpl
    .replace(/\{\{TITLE\}\}/g, escapeHtml(title))
    .replace(/\{\{STREAM_URL\}\}/g, streamUrl.replace(/"/g, '%22'));
}

/* ------------------------- index.html rendering rules -----------------------
 * The channel STRUCTURE is untouched: same <nav class="grid" id="channels">
 * container, same plain <a href="file.html">Name</a> entries, same search /
 * filter script. Only the source of truth changes: the list now lives in
 * channels.json and index.html is regenerated from it.
 * -------------------------------------------------------------------------- */

function renderIndexLinks(channels) {
  const key = c => String(c.name).toLowerCase();
  return channels
    .slice()
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .map(c => '  <a href="' + hrefFor(c.file) + '">' + escapeHtml(c.name) + '</a>')
    .join('\n');
}

function regenerateIndexLocal(channels) {
  if (!fs.existsSync(INDEX_FILE)) fail('index.html not found.');
  const html = fs.readFileSync(INDEX_FILE, 'utf8');
  const navStart = html.indexOf('<nav class="grid"');
  if (navStart === -1) fail('Could not find the channel grid in index.html.');
  const bodyStart = html.indexOf('>', navStart) + 1;
  const navEnd = html.indexOf('</nav>', bodyStart);
  if (navEnd === -1) fail('Could not find </nav> in index.html.');
  const rebuilt = html.slice(0, bodyStart) + '\n' + renderIndexLinks(channels) + '\n' + html.slice(navEnd);
  fs.writeFileSync(INDEX_FILE, rebuilt);
}

// Regenerate the <nav> body inside an index.html string (used for remote commits).
function regenerateIndexString(indexHtml, channels) {
  const navStart = indexHtml.indexOf('<nav class="grid"');
  if (navStart === -1) throw new Error('Could not find the channel grid in index.html.');
  const bodyStart = indexHtml.indexOf('>', navStart) + 1;
  const navEnd = indexHtml.indexOf('</nav>', bodyStart);
  if (navEnd === -1) throw new Error('Could not find </nav> in index.html.');
  return indexHtml.slice(0, bodyStart) + '\n' + renderIndexLinks(channels) + '\n' + indexHtml.slice(navEnd);
}

function upsertChannelEntry(channels, file, name) {
  const next = channels.filter(c => c.file !== file);
  next.push({ file, name });
  return next;
}

function removeChannelEntry(channels, file) {
  return channels.filter(c => c.file !== file);
}

/* ------------------------------ GitHub API ---------------------------------- */

function ghHeaders(token) {
  return {
    'Authorization': 'token ' + token,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'channel-admin'
  };
}

async function ghFetch(token, cfg, p, init) {
  const url = 'https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' +
              encodeURIComponent(cfg.repo) + p;
  return fetch(url, Object.assign({}, init, { headers: ghHeaders(token) }));
}

async function fetchRemoteFile(token, cfg, filePath) {
  const r = await ghFetch(token, cfg,
    '/contents/' + encodeURIComponent(filePath) + '?ref=' + encodeURIComponent(cfg.branch),
    { method: 'GET' });
  if (r.status === 404) return { exists: false, sha: null, content: null };
  if (!r.ok) throw new Error('GitHub read failed (' + r.status + ') for ' + filePath + '. Check owner/repo/token.');
  const j = await r.json();
  return {
    exists: true,
    sha: j.sha,
    content: j.content ? Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8') : ''
  };
}

async function commitFile(token, cfg, filePath, content, message) {
  const cur = await fetchRemoteFile(token, cfg, filePath);
  const body = {
    message,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: cfg.branch
  };
  if (cur.exists) body.sha = cur.sha;
  const r = await ghFetch(token, cfg, '/contents/' + encodeURIComponent(filePath),
    { method: 'PUT', body: JSON.stringify(body) });
  if (!r.ok) throw new Error('GitHub write failed (' + r.status + ') for ' + filePath + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

module.exports = {
  ROOT, TEMPLATE_FILE, INDEX_FILE, CHANNELS_FILE, VAULT_FILE, PLAINTEXT_FILE,
  RESERVED,
  fail, escapeHtml, hrefFor, slug, pretty, parseArgs,
  encryptToken, decryptToken, getToken, readPassphraseFromTTY,
  readChannelsJson, writeChannelsJson, getRepoConfig,
  loadTemplate, buildPage,
  renderIndexLinks, regenerateIndexLocal, regenerateIndexString,
  upsertChannelEntry, removeChannelEntry,
  fetchRemoteFile, commitFile
};
