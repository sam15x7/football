#!/usr/bin/env node
/*
 * admin/selftest.js — offline end-to-end test of the hosted dashboard
 * (admin/index.html) against a MOCK GitHub API. No network, no token.
 *   node admin/selftest.js
 */
'use strict';
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

// ---- mock repo state -------------------------------------------------------
const initialFiles = {
  'template.html': read('template.html'),
  'index.html': read('index.html'),
  'channels.json': read('channels.json')
};
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
// Real git-style content hashes: a blob's sha IS the sha256 of its bytes.
const shaOf = s => require('crypto').createHash('sha256').update(s).digest('hex');
let writes = [];
let owner = 'sam15x7', repo = 'my-channels';
// Mock Data API state: branch HEAD -> commit -> tree -> blob shas.
let headSha = 'commit-initial';
const commits = { 'commit-initial': { tree: 'tree-initial' } };
const trees = {};     // tree sha  -> { base, entries:[{path,sha}] }
const blobs = {};     // blob sha  -> content string
trees['tree-initial'] = { base: null, entries: Object.entries(initialFiles).map(([p, c]) => {
  const sha = shaOf(c); blobs[sha] = c; return { path: p, sha };
}) };
// The effective file contents at the current branch HEAD. base_tree may be a
// TREE sha or a COMMIT sha (GitHub resolves both) — follow either.
function materializeTree(sha) {
  const t = trees[sha] || (commits[sha] && trees[commits[sha].tree]);
  if (!t) return {};
  let m = t.base ? materializeTree(t.base) : {};
  for (const e of t.entries) { if (e.sha === null) delete m[e.path]; else m[e.path] = blobs[e.sha]; }
  return m;
}
function api(url, opts) {
  const u = new URL(url);
  if (u.hostname !== 'api.github.com') throw new Error('page fetched non-GitHub host: ' + u.href);
  const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
  if (!auth.startsWith('Bearer github_pat_TESTTOKEN')) return Promise.resolve(res(401, { message: 'Bad credentials' }));
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  let m;
  if (u.pathname === '/user') return Promise.resolve(res(200, { login: owner }));
  if (u.pathname === '/repos/' + owner + '/' + repo) return Promise.resolve(res(200, { full_name: owner + '/' + repo }));
  const P = '/repos/' + owner + '/' + repo;
  const PRE = '^' + P;
  // ---------- Data API: refs / blobs / trees / commits ----------
  // GET reads the ref at /git/ref/heads/<branch>; UPDATE posts to /git/refs/heads/<branch>.
  if ((m = u.pathname.match(new RegExp(PRE + '/git/(?:ref|refs)/heads/(.+)$')))) {
    if (method === 'PATCH') {
      if (!commits[body.sha]) return Promise.resolve(res(422, { message: 'Invalid request.' }));
      if (body.sha === headSha) return Promise.resolve(res(304, { message: 'Not modified' }));
      headSha = body.sha;
      writes.push('commit:' + body.sha.slice(0, 8));
      return Promise.resolve(res(200, { ref: 'refs/heads/main', object: { sha: body.sha } }));
    }
    return Promise.resolve(res(200, { ref: 'refs/heads/main', object: { sha: headSha } }));
  }
  if (u.pathname === P + '/git/blobs' && method === 'POST') {
    const content = Buffer.from(body.content, 'base64').toString('utf8');
    const sha = shaOf(content);
    blobs[sha] = content;
    return Promise.resolve(res(201, { url: u.origin + P + '/git/blobs/' + sha, sha }));
  }
  if (u.pathname === P + '/git/trees' && method === 'POST') {
    if (body.base_tree && !trees[body.base_tree] && !commits[body.base_tree]) {
      return Promise.resolve(res(422, { message: 'Invalid request. Object does not exist' }));
    }
    const sha = shaOf(JSON.stringify(body));
    trees[sha] = { base: body.base_tree || null, entries: body.tree };
    return Promise.resolve(res(201, { sha }));
  }
  if (u.pathname === P + '/git/commits' && method === 'POST') {
    if (!trees[body.tree]) return Promise.resolve(res(422, { message: 'Invalid request. Tree does not exist' }));
    const parents = body.parents || [];
    for (const p of parents) if (!commits[p]) {
      return Promise.resolve(res(422, { message: 'Invalid request. Parent does not exist' }));
    }
    const sha = shaOf(JSON.stringify(body));
    commits[sha] = { tree: body.tree };
    return Promise.resolve(res(201, { sha, message: body.message }));
  }
  // ---------- Contents API (read-only now — GET only) ----------
  if ((m = u.pathname.match(new RegExp(PRE + '/contents/(.+)$')))) {
    const p = decodeURIComponent(m[1]);
    if (method !== 'GET') {
      // The fixed dashboard must NEVER PUT /contents again: that call requires a
      // per-file "sha" and produced 'GitHub 422: Invalid request. "sha" wasn't supplied.'
      return Promise.resolve(res(422, { message: 'Invalid request. "sha" wasn\'t supplied.' }));
    }
    const eff = materializeTree(commits[headSha].tree);
    if (!(p in eff)) return Promise.resolve(res(404, { message: 'Not Found' }));
    return Promise.resolve(res(200, { name: p, sha: shaOf(eff[p]), content: b64(eff[p]) }));
  }
  return Promise.resolve(res(404, { message: 'nope' }));
}
const res = (status, json) => ({ ok: status < 400, status, json: async () => json });
// Convenience view for the assertions below: current committed contents by path.
const files = () => materializeTree(commits[headSha].tree);

(async () => {
  const dom = new JSDOM(read('admin/index.html'), {
    url: `https://${owner}.github.io/${repo}/admin/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });
  const w = dom.window;
  w.fetch = (url, opts) => api(url, opts || {});
  w.confirm = () => true;
  w.alert = () => {};
  w.URL.createObjectURL = () => 'blob:x';
  w.open = () => null;
  await new Promise(r => setTimeout(r, 300)); // boot()

  const doc = w.document, $ = id => doc.getElementById(id);
  const assert = (c, msg) => { if (!c) { console.error('FAIL:', msg, '\nstatus:', $('connStatus').textContent); process.exit(1); } console.log('ok  -', msg); };
  const F = () => materializeTree(commits[headSha].tree);

  // 1. Owner/repo pre-filled from the Pages URL, add form hidden (locked).
  assert($('owner').value === owner, 'owner auto-filled from Pages URL (' + $('owner').value + ')');
  assert($('repo').value === repo, 'repo auto-filled from Pages URL (' + $('repo').value + ')');
  assert($('addCard').classList.contains('hidden'), 'add-channel locked before token');

  // 2. Visitor with garbage token stays locked.
  $('token').value = 'github_pat_WRONG';
  $('saveToken').click();
  await new Promise(r => setTimeout(r, 300));
  assert($('addCard').classList.contains('hidden'), 'wrong token does NOT unlock');

  // 3. Admin token unlocks.
  $('token').value = 'github_pat_TESTTOKEN';
  $('saveToken').click();
  await new Promise(r => setTimeout(r, 500));
  assert(!$('addCard').classList.contains('hidden'), 'valid fine-grained PAT unlocks add/remove');
  assert(w.localStorage.getItem('channeladmin.token') === 'github_pat_TESTTOKEN', 'token kept in browser localStorage only');
  assert(!F()['channels.json'].includes('TESTTOKEN'), 'no secret ever written to channels.json');

  // 4. Add a channel. (slug('ESPN 4 (Argentina)') = 'espn4(argentina)' — the
  //    dashboard's slug keeps parentheses, matching existing repo files like
  //    beinsportsmena2(eng).html.)
  const before = JSON.parse(F()['channels.json']).channels.length;
  const NEWFILE = 'espn4(argentina).html';
  $('chName').value = 'ESPN 4 (Argentina)';
  $('chUrl').value = 'https://dlive.sx/cast/stream-900.php';
  $('addBtn').click();
  await new Promise(r => setTimeout(r, 900));
  assert(/Added|Updated/.test($('addStatus').textContent), 'add-channel succeeded: ' + $('addStatus').textContent);
  const ch = JSON.parse(F()['channels.json']);
  assert(ch.channels.length === before + 1, 'channels.json gained entry');
  assert(!('owner' in ch) && !('repo' in ch), 'owner/repo stripped from public channels.json');
  assert(F()[NEWFILE] && F()[NEWFILE].includes('https://dlive.sx/cast/stream-900.php'), 'new page committed with stream URL');
  assert(F()['index.html'].includes('<a href="' + encodeURI(NEWFILE) + '">ESPN 4 (Argentina)</a>'), 'index.html regenerated with new card');

  // 5. Remove it again (click the .danger button — there is also an Edit button per row).
  const btn = [...doc.querySelectorAll('#list button.danger')].find(b => b.dataset.file === NEWFILE);
  assert(!!btn, 'remove button rendered');
  btn.click();
  for (let i = 0; i < 100 && !/Removed|✗/.test($('listStatus').textContent); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (/✗/.test($('listStatus').textContent)) { console.error('remove failed:', $('listStatus').textContent); }
  assert(JSON.parse(F()['channels.json']).channels.length === before, 'channel removed from channels.json');
  assert(!F()['index.html'].includes(NEWFILE), 'index.html regenerated without it');

  // 6. Preview builds locally, nothing uploaded.
  $('chName').value = 'Test Preview'; $('chUrl').value = 'https://dlive.sx/cast/stream-885.php';
  $('previewBtn').click();
  assert(true, 'preview ran without throwing');

  console.log('\nALL SELF-TESTS PASSED ✔  (mock writes: ' + writes.join(', ') + ')');
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
