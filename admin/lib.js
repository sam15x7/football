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
 * Redesigned public index: one <nav class="grid" id="channels"> container,
 * but every card is now a <div class="card" data-sport data-region data-tags>
 * wrapping an <a>. The tags/classification attributes are GENERATED from
 * channels.json by these functions — never hand-edit the grid.
 *
 * Classification model (per channel entry in channels.json):
 *   sport  : string[]  canonical sport tags        (["football"], ["tennis","mma"])
 *   region : string    optional country/region     ("UK", "MENA", ...)
 *   tags   : string[]  free-form extras            (["premier league","hd"])
 * Everything stays OPTIONAL and backward compatible: entries without any of
 * them still render as plain cards; only present metadata becomes data-* attrs.
 * -------------------------------------------------------------------------- */

const SPORT_ALIASES = {
  'soccer': 'football', 'association football': 'football',
  'basket': 'basketball', 'basket ball': 'basketball',
  'ice hockey': 'hockey',
  'auto racing': 'motorsport', 'motor racing': 'motorsport', 'racing': 'motorsport',
  'formula 1': 'f1', 'formula-one': 'f1',
  'american football': 'nfl', 'nfl football': 'nfl',
  'mixed martial arts': 'mma',
  'olympic sports': 'olympics',
  'sports': '', 'sport': ''              // generic words are not classifications
};

// "F1", "Formula-1", " formula 1 " -> "f1"; unknown terms pass through lowercased.
function normTag(raw) {
  const s0 = String(raw == null ? '' : raw).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s0) return '';
  return SPORT_ALIASES.hasOwnProperty(s0) ? SPORT_ALIASES[s0] : s0;
}

function tagList(v) {
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(/[,;]/));
  const out = [];
  for (const t of arr) {
    const n = normTag(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

// Return the classification fields of a channel entry (normalized, or absent).
function classifyChannel(c) {
  const out = {};
  const sports = tagList(c.sport !== undefined ? c.sport : c.sports);
  if (sports.length) out.sport = sports;
  const region = String(c.region || '').trim();
  if (region) out.region = region;
  const tags = tagList(c.tags);
  if (tags.length) out.tags = tags;
  return out;
}

// Normalize classification fields on every entry (used before writing channels.json).
function setTags(channels) {
  return channels.map(c => {
    const cls = classifyChannel(c);
    const next = Object.assign({}, c);
    if (cls.sport) next.sport = cls.sport; else delete next.sport;
    if (cls.region) next.region = cls.region; else delete next.region;
    if (cls.tags) next.tags = cls.tags; else delete next.tags;
    return next;
  });
}

// Union of every sport tag in use — powers the dashboard's tag suggestions.
function allSports(channels) {
  const seen = [];
  for (const c of channels) {
    for (const s of tagList(c.sport !== undefined ? c.sport : c.sports)) {
      if (!seen.includes(s)) seen.push(s);
    }
  }
  return seen.sort();
}

// One card per channel: plain <a> when unclassified, otherwise a wrapper
// <div class="card" data-region data-sport> carrying the classification and
// an inner <a> whose data-* attributes hold the FULL machine-readable tags
// (the public page's filter script reads name/href/data-tags from each <a>).
function renderIndexLinks(channels) {
  const key = c => String(c.name).toLowerCase();
  return channels
    .slice()
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
    .map(c => {
      const cls = classifyChannel(c);
      const attrs = [];
      if (cls.sport) attrs.push('data-sport="' + escapeHtml(cls.sport.join(',')) + '"');
      if (cls.region) attrs.push('data-region="' + escapeHtml(cls.region.toLowerCase()) + '"');
      if (cls.tags) attrs.push('data-tags="' + escapeHtml(cls.tags.join(',')) + '"');
      const a = '<a href="' + hrefFor(c.file) + '"' + (attrs.length ? ' ' + attrs.join(' ') : '') +
                '>' + escapeHtml(c.name) + '</a>';
      if (cls.sport || cls.region || cls.tags) {
        const wrap = [];
        if (cls.sport) wrap.push('data-sport="' + escapeHtml(cls.sport.join(',')) + '"');
        if (cls.region) wrap.push('data-region="' + escapeHtml(cls.region.toLowerCase()) + '"');
        return '  <div class="card"' + (wrap.length ? ' ' + wrap.join(' ') : '') + '>' + a + '</div>';
      }
      return '  ' + a;
    })
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

// Upsert a channel entry. `meta` optionally carries { sport, region, tags } —
// classification fields are normalized via setTags-style rules; passing no meta
// (or an unclassified edit) PRESERVES the existing tags of that channel.
function upsertChannelEntry(channels, file, name, meta) {
  const prev = channels.find(c => c.file === file) || {};
  const entry = Object.assign({}, prev, { file, name });
  if (meta && (meta.sport !== undefined || meta.region !== undefined || meta.tags !== undefined)) {
    if (meta.sport !== undefined) entry.sport = meta.sport;
    if (meta.region !== undefined) entry.region = meta.region;
    if (meta.tags !== undefined) entry.tags = meta.tags;
  }
  const next = channels.filter(c => c.file !== file);
  next.push(setTags([entry])[0]);
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

// URL-encode each path segment individually — encodeURIComponent on the WHOLE
// path would turn "a/b.html" into "a%2Fb.html", which GitHub's Contents API
// does not resolve as a nested path.
function encodePath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

// Read a file's CURRENT sha from GitHub with cache-busting (?ref=<branch>, no
// If-None-Match). A stale/304-cached response without a sha is treated as a
// miss so callers never send an undefined "sha".
async function fetchRemoteFile(token, cfg, filePath) {
  const r = await ghFetch(token, cfg,
    '/contents/' + encodePath(filePath) + '?ref=' + encodeURIComponent(cfg.branch),
    { method: 'GET', cache: 'no-store' });
  if (r.status === 404) return { exists: false, sha: null, content: null };
  if (!r.ok) throw new Error('GitHub read failed (' + r.status + ') for ' + filePath + '. Check owner/repo/token.');
  const j = await r.json();
  // Directories/symlinks come back as arrays — never usable as a file sha.
  const sha = (!Array.isArray(j) && typeof j.sha === 'string' && j.sha) || null;
  return {
    exists: !!sha,
    sha,
    content: j.content ? Buffer.from(String(j.content).replace(/\n/g, ''), 'base64').toString('utf8') : ''
  };
}

/* ------------------------- atomic multi-file commits ------------------------
 * The Data API (git/refs + git/trees + git/commits + PATCH ref) writes several
 * files in ONE commit and NEVER requires a per-file blob sha — only the parent
 * commit's sha. This sidesteps the classic GitHub Contents-API failure:
 *   422 Invalid request. "sha" wasn't supplied.
 * which happens whenever the cached sha of a file goes missing/stale (e.g. a
 * browser-cached GET, or the file changed between reading and writing).
 * --------------------------------------------------------------------------- */

async function getBranchHeadSha(token, cfg) {
  const r = await ghFetch(token, cfg, '/git/ref/heads/' + encodeURIComponent(cfg.branch),
                          { method: 'GET', cache: 'no-store' });
  if (!r.ok) throw new Error('GitHub could not read branch "' + cfg.branch + '" (' + r.status +
                             '). Check owner/repo/token and that the branch exists.');
  const j = await r.json();
  const sha = j && j.object && j.object.sha;
  if (!sha) throw new Error('GitHub returned no HEAD sha for branch "' + cfg.branch + '".');
  return sha;
}

/* ---------------- ref races: "Update is not a fast forward" -----------------
 * PATCH /git/refs only advances the branch if the new commit's parent IS the
 * current branch tip. If another push (a second admin tab, the CLI, or a
 * manual git push) lands between our HEAD read and the PATCH, GitHub answers:
 *   422 Update is not a fast forward
 * Fix: optimistic concurrency control — on conflict, re-read the fresh HEAD,
 * rebuild tree+commit on top of it, and retry (up to 3 attempts). If the race
 * keeps losing, fall back to creating a MERGE commit whose parents are
 * [ourCommit, remoteTip]: that commit is by construction a descendant of the
 * remote tip, so advancing the ref to it IS a fast-forward again.
 * --------------------------------------------------------------------------- */

class RefConflictError extends Error {
  constructor(message) { super(message); this.name = 'RefConflictError'; this.refConflict = true; }
}

function isRefConflict(status, text) {
  return status === 422 && /not a fast[- ]?forward/i.test(text || '');
}

async function ghJson(r) {
  try { return await r.json(); } catch (_) { return {}; }
}

// Build blobs + tree for `entries` on top of headSha. Returns the tree object.
async function buildTree(token, cfg, headSha, entries) {
  const blobs = await Promise.all(entries.map(async f => {
    const r = await ghFetch(token, cfg, '/git/blobs', {
      method: 'POST', cache: 'no-store',
      body: JSON.stringify({ content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64' })
    });
    if (!r.ok) throw new Error('GitHub blob upload failed (' + r.status + ') for ' + f.path + ': ' +
                               String(await r.text().catch(() => '')).slice(0, 200));
    const j = await ghJson(r);
    if (!j.sha) throw new Error('GitHub returned no sha for blob ' + f.path + '.');
    return { path: f.path, mode: '100644', type: 'blob', sha: j.sha };
  }));
  const rt = await ghFetch(token, cfg, '/git/trees', {
    method: 'POST', cache: 'no-store',
    body: JSON.stringify({ base_tree: headSha, tree: blobs })
  });
  if (!rt.ok) throw new Error('GitHub tree creation failed (' + rt.status + '): ' +
                              String(await rt.text().catch(() => '')).slice(0, 200));
  return ghJson(rt);
}

async function createCommit(token, cfg, message, parents, treeSha) {
  const rc = await ghFetch(token, cfg, '/git/commits', {
    method: 'POST', cache: 'no-store',
    body: JSON.stringify({ message, parents, tree: treeSha })
  });
  if (!rc.ok) throw new Error('GitHub commit creation failed (' + rc.status + '): ' +
                              String(await rc.text().catch(() => '')).slice(0, 200));
  return ghJson(rc);
}

// Advance the branch ref WITHOUT force. Returns:
//   { ok: true, commit } | { conflict: true } | throws on other errors.
async function advanceRef(token, cfg, commitSha) {
  const rr = await ghFetch(token, cfg, '/git/refs/heads/' + encodeURIComponent(cfg.branch), {
    method: 'PATCH', cache: 'no-store',
    body: JSON.stringify({ sha: commitSha, force: false })
  });
  if (rr.ok) return { ok: true };
  const text = String(await rr.text().catch(() => ''));
  // 422 "Update is not a fast forward" / stale-info → recoverable race.
  if (isRefConflict(rr.status, text)) return { conflict: true };
  // A commit identical to the current tip: nothing to do, treat as success.
  if (rr.status === 304 || /not modified/i.test(text)) return { ok: true };
  throw new Error('GitHub could not advance "' + cfg.branch + '" (' + rr.status + '): ' + text.slice(0, 200));
}

// One full attempt: fresh HEAD → tree → commit → non-forced PATCH ref.
// Throws RefConflictError when the branch moved under us mid-flight.
async function tryCommitOnce(token, cfg, entries, message, prebuiltTree) {
  const headSha = await getBranchHeadSha(token, cfg);           // fresh every attempt
  const tree = prebuiltTree || await buildTree(token, cfg, headSha, entries);
  const commit = await createCommit(token, cfg, message, [headSha], tree.sha);
  const res = await advanceRef(token, cfg, commit.sha);
  if (res.conflict) throw new RefConflictError(
    'Update is not a fast forward — another change landed on "' + cfg.branch + '" while committing.');
  return commit;
}

// Commit `entries` on cfg.branch with up to `attempts` rebuild-on-race retries.
async function commitWithRetry(token, cfg, entries, message, attempts) {
  const max = attempts || 3;
  let lastErr;
  for (let i = 0; i < max; i++) {
    try { return await tryCommitOnce(token, cfg, entries, message); }
    catch (e) {
      if (!e.refConflict) throw e;                              // real errors surface immediately
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));     // small backoff before rebuilding
    }
  }
  throw lastErr;
}

// Last-resort recovery when plain retries keep losing the race: build our
// commit against the CURRENT tip, then merge the remote tip into it with a
// two-parent commit (tree reused from ours). That merge commit descends from
// whatever HEAD became, so advancing the ref to it is a fast-forward again.
async function commitMerging(token, cfg, entries, message) {
  const headA = await getBranchHeadSha(token, cfg);
  const tree = await buildTree(token, cfg, headA, entries);
  const ours = await createCommit(token, cfg, message, [headA], tree.sha);
  const first = await advanceRef(token, cfg, ours.sha);
  if (first.ok) return ours;                                    // no race after all
  const remoteTip = await getBranchHeadSha(token, cfg);
  if (remoteTip === headA) {
    // Tip never moved yet PATCH refused — surface the original failure mode.
    throw new Error('GitHub 422: Update is not a fast forward on "' + cfg.branch +
                    '". The branch may be protected or behind by history we cannot see; retry shortly.');
  }
  const merge = await createCommit(
    token, cfg,
    'Merge latest "' + cfg.branch + '" changes (admin auto-retry)',
    [ours.sha, remoteTip], tree.sha);
  const second = await advanceRef(token, cfg, merge.sha);
  if (second.ok) return merge;
  throw new Error('GitHub 422: Update is not a fast forward — "' + cfg.branch +
                  '" changed repeatedly during this write. Nothing was committed; please retry.');
}

// files: [{ path, content }] — all entries land in one atomic commit on cfg.branch.
async function commitFiles(token, cfg, files, message) {
  const clean = files.map(f => ({ path: String(f.path).replace(/^\/+/, ''), content: f.content }));
  for (const f of clean) {
    if (!f.path) throw new Error('Empty file path in commit batch.');
    if (typeof f.content !== 'string') throw new Error('Content for ' + f.path + ' must be a string.');
  }
  try {
    return await commitWithRetry(token, cfg, clean, message);
  } catch (e) {
    if (!e.refConflict) throw e;
    return commitMerging(token, cfg, clean, message);           // persistent race → merge-commit fallback
  }
}

// Single-file convenience wrapper (atomic Data API — no per-file sha needed).
async function commitFile(token, cfg, filePath, content, message) {
  return commitFiles(token, cfg, [{ path: filePath, content }], message);
}

// Delete a remote file atomically (tree entry with null sha), with the same
// race recovery: every attempt recomputes the delete-tree against the FRESH
// branch tip, so a concurrent push can never produce
// 422 "Update is not a fast forward" without an automatic rebuild+retry.
async function deleteFile(token, cfg, filePath, message) {
  const deleteTree = async (headSha) => {
    const rt = await ghFetch(token, cfg, '/git/trees', {
      method: 'POST', cache: 'no-store',
      body: JSON.stringify({ base_tree: headSha, tree: [{ path: filePath, mode: '100644', type: 'blob', sha: null }] })
    });
    if (rt.status === 422) return null;                         // path not on this tip — nothing to delete
    if (!rt.ok) throw new Error('GitHub tree creation failed (' + rt.status + '): ' +
                                String(await rt.text().catch(() => '')).slice(0, 200));
    return ghJson(rt);
  };
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const headSha = await getBranchHeadSha(token, cfg);
      const tree = await deleteTree(headSha);
      if (!tree) return false;
      const commit = await createCommit(token, cfg, message, [headSha], tree.sha);
      const res = await advanceRef(token, cfg, commit.sha);
      if (res.ok) return true;
      throw new RefConflictError('fast-forward race');
    } catch (e) {
      if (!e.refConflict) throw e;
      lastErr = e;
      await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  // Persistent race: merge route, same as writes.
  const headA = await getBranchHeadSha(token, cfg);
  const tree = await deleteTree(headA);
  if (!tree) return false;
  const ours = await createCommit(token, cfg, message, [headA], tree.sha);
  const remoteTip = await getBranchHeadSha(token, cfg);
  if (remoteTip === headA) {
    const first = await advanceRef(token, cfg, ours.sha);
    if (first.ok) return true;
    throw new Error('GitHub 422: Update is not a fast forward on "' + cfg.branch + '". Retry shortly.');
  }
  const merge = await createCommit(
    token, cfg, 'Merge latest "' + cfg.branch + '" changes (admin auto-retry)',
    [ours.sha, remoteTip], tree.sha);
  const second = await advanceRef(token, cfg, merge.sha);
  if (second.ok) return true;
  void lastErr;
  throw new Error('GitHub 422: Update is not a fast forward — "' + cfg.branch +
                  '" changed repeatedly during this delete. Nothing was committed; please retry.');
}

module.exports = {
  ROOT, TEMPLATE_FILE, INDEX_FILE, CHANNELS_FILE, VAULT_FILE, PLAINTEXT_FILE,
  RESERVED,
  fail, escapeHtml, hrefFor, slug, pretty, parseArgs,
  encryptToken, decryptToken, getToken, readPassphraseFromTTY,
  readChannelsJson, writeChannelsJson, getRepoConfig,
  loadTemplate, buildPage,
  renderIndexLinks, regenerateIndexLocal, regenerateIndexString,
  normTag, tagList, classifyChannel, setTags, allSports,
  upsertChannelEntry, removeChannelEntry,
  encodePath, getBranchHeadSha, fetchRemoteFile, commitFile, commitFiles, deleteFile
};
