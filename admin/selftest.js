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
const files = {
  'template.html': read('template.html'),
  'index.html': read('index.html'),
  'channels.json': read('channels.json')
};
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
let writes = [];
let owner = 'sam15x7', repo = 'my-channels';
function api(url, opts) {
  const u = new URL(url);
  if (u.hostname !== 'api.github.com') throw new Error('page fetched non-GitHub host: ' + u.href);
  const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
  if (!auth.startsWith('Bearer github_pat_TESTTOKEN')) return Promise.resolve(res(401, { message: 'Bad credentials' }));
  let m;
  if (u.pathname === '/users') return Promise.resolve(res(200, { login: owner }));
  if ((m = u.pathname.match(new RegExp('^/repos/' + owner + '/' + repo + '/contents/(.+)$')))) {
    const p = decodeURIComponent(m[1]);
    if ((opts.method || 'GET') === 'PUT') {
      if (!files[p]) writes.push('create'); else writes.push('update');
      const body = JSON.parse(opts.body);
      if (files[p] && body.sha !== 'sha-' + p) return Promise.resolve(res(409, { message: 'SHA mismatch: ' + body.sha }));
      files[p] = Buffer.from(body.content, 'base64').toString('utf8');
      return Promise.resolve(res(201, { content: { sha: 'sha-' + p } }));
    }
    if (!files[p]) return Promise.resolve(res(404, { message: 'Not Found' }));
    return Promise.resolve(res(200, { name: p, sha: 'sha-' + p, content: b64(files[p]) }));
  }
  return Promise.resolve(res(404, { message: 'nope' }));
}
const res = (status, json) => ({ ok: status < 400, status, json: async () => json });

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
  assert(!files['channels.json'].includes('TESTTOKEN'), 'no secret ever written to channels.json');

  // 4. Add a channel. (slug('ESPN 4 (Argentina)') = 'espn4(argentina)' — the
  //    dashboard's slug keeps parentheses, matching existing repo files like
  //    beinsportsmena2(eng).html.)
  const before = JSON.parse(files['channels.json']).channels.length;
  const NEWFILE = 'espn4(argentina).html';
  $('chName').value = 'ESPN 4 (Argentina)';
  $('chUrl').value = 'https://dlive.sx/cast/stream-900.php';
  $('addBtn').click();
  await new Promise(r => setTimeout(r, 900));
  assert(/Added|Updated/.test($('addStatus').textContent), 'add-channel succeeded: ' + $('addStatus').textContent);
  const ch = JSON.parse(files['channels.json']);
  assert(ch.channels.length === before + 1, 'channels.json gained entry');
  assert(!('owner' in ch) && !('repo' in ch), 'owner/repo stripped from public channels.json');
  assert(files[NEWFILE] && files[NEWFILE].includes('https://dlive.sx/cast/stream-900.php'), 'new page committed with stream URL');
  assert(files['index.html'].includes('<a href="' + encodeURI(NEWFILE) + '">ESPN 4 (Argentina)</a>'), 'index.html regenerated with new card');

  // 5. Remove it again (click the .danger button — there is also an Edit button per row).
  const btn = [...doc.querySelectorAll('#list button.danger')].find(b => b.dataset.file === NEWFILE);
  assert(!!btn, 'remove button rendered');
  btn.click();
  for (let i = 0; i < 100 && !/Removed|✗/.test($('listStatus').textContent); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (/✗/.test($('listStatus').textContent)) { console.error('remove failed:', $('listStatus').textContent); }
  assert(JSON.parse(files['channels.json']).channels.length === before, 'channel removed from channels.json');
  assert(!files['index.html'].includes(NEWFILE), 'index.html regenerated without it');

  // 6. Preview builds locally, nothing uploaded.
  $('chName').value = 'Test Preview'; $('chUrl').value = 'https://dlive.sx/cast/stream-885.php';
  $('previewBtn').click();
  assert(true, 'preview ran without throwing');

  console.log('\nALL SELF-TESTS PASSED ✔  (mock writes: ' + writes.join(', ') + ')');
  process.exit(0);
})().catch(e => { console.error('CRASH:', e); process.exit(1); });
