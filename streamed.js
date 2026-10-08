#!/usr/bin/env node
/*
 * streamed.js — pull live sport streams from the Streamed API (https://streamed.pk/docs)
 *                 straight into this GitHub Pages channel repo.
 *
 * What it does:
 *   --list                show today's / live matches with their source + id
 *   --search <text>       find a match by team / title text
 *   --embed <source/id>   print the ready-to-paste <iframe ...> tag for a stream
 *   --new <slug>          create a channel page (from template.html) wired to a
 *                         Streamed match — works for finished matches too, because
 *                         the embed URL is built as https://embed.st/embed/<source>/<id>/<n>
 *   --update <slug>       re-resolve an existing page's Streamed source/id and refresh
 *                         its iframe (useful when a new feed / stream number appears)
 *   --channels            list the pages that are already Streamed-powered
 *
 * Examples:
 *   node streamed.js --list --sport football --live
 *   node streamed.js --search "Nascar"
 *   node streamed.js --embed delta/live-event_nascar-cup-series-2026-south-point-400-live-stream
 *   node streamed.js --new nascarsouthpoint --match ppv-adelaide-36-ers-vs-melbourne-united \
 *                    --name "Adelaide 36ers vs Melbourne United" --lang ESPN --hd
 *   node streamed.js --update nascarsouthpoint
 *
 * Notes:
 *   • No API key is needed; the endpoints are public JSON.
 *   • Stream ids change per event, so never hand-write them — always resolve with
 *     --list / --search, or let --new store a comment marker so --update can re-resolve.
 *   • This script only writes files inside the repo folder, exactly like new-channel.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE_FILE = path.join(ROOT, 'template.html');
const INDEX_FILE = path.join(ROOT, 'index.html');
const NEW_FILE = 'new.html';
const RESERVED = ['index.html', 'template.html'];

const API_BASE = process.env.STREAMED_API || 'https://streamed.pk';
const EMBED_HOST = process.env.STREAMED_EMBED || 'https://embed.st';

/* ------------------------------ arguments ------------------------------ */

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else { opts[key] = next; i++; }
  }
  return opts;
}

function fail(msg) {
  console.error('\n  ✗ ' + msg + '\n');
  process.exit(1);
}

/* ------------------------------- HTTP ---------------------------------- */

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
  return res.json();
}

async function streams(source, id) {
  const url = `${API_BASE}/api/stream/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;
  const data = await getJson(url).catch(() => null);
  return Array.isArray(data) ? data : [];
}

/* ----------------------------- discovery ------------------------------- */

function listEndpoint(opts) {
  if (opts.live) return opts.sport ? `matches/${opts.sport}/live` : 'live';
  if (opts.sport) return `matches/${opts.sport}`;
  if (opts.all) return 'all';
  return 'all-today';
}

function fmtDate(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

function pickStream(list, opts) {
  if (!list.length) return null;
  let out = list.slice();
  if (opts.lang) {
    const want = String(opts.lang).toLowerCase();
    out = out.filter(s => String(s.language || '').toLowerCase().includes(want)) .concat(out);
  }
  if (opts.hd) {
    const hds = out.filter(s => s.hd);
    if (hds.length) out = hds.concat(out);
  }
  if (typeof opts.stream === 'string' && opts.stream !== true) {
    const n = Number(opts.stream);
    const found = list.find(s => s.streamNo === n);
    if (found) return found;
  }
  // de-duplicate while keeping order
  const seen = new Set();
  out = out.filter(s => {
    const k = `${s.source}/${s.id}/${s.streamNo}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out[0] || list[0];
}

function embedUrlFor(source, id, streamNo) {
  return `${EMBED_HOST}/embed/${source}/${id}/${streamNo || 1}`;
}

function iframeTag(url) {
  return `<iframe src="${url}" width="100%" height="100%" style="border:0;" allowfullscreen></iframe>`;
}

/* ------------------------- page generation bits ------------------------ */

function slug(raw) {
  const s = String(raw || '')
    .trim()
    .replace(/\.html?$/i, '')
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9._()-]/g, '')
    .toLowerCase();
  if (!s) fail('Channel name is empty after cleaning. Use letters and digits, e.g. "nascarsouthpoint".');
  if (/^[.\-_()]/.test(s)) fail('Channel name cannot start with . - _ or ( : "' + raw + '"');
  return s + '.html';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function hrefFor(fileName) {
  return encodeURI(fileName);
}

function channelFiles() {
  return fs.readdirSync(ROOT)
    .filter(f => /\.html$/i.test(f) && !RESERVED.includes(f) && f !== NEW_FILE)
    .sort((a, b) => a.localeCompare(b));
}

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

// Marker comment so a page can be re-resolved later with --update.
const MARKER = 'streamed:';
function markerTag(source, id, extra) {
  return `<!-- ${MARKER}${source}/${id}${extra ? ' ' + extra : ''} -->`;
}

function loadTemplate() {
  if (!fs.existsSync(TEMPLATE_FILE)) fail('template.html is missing from ' + ROOT + '.');
  const tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  for (const token of ['{{TITLE}}', '{{STREAM_URL}}']) {
    if (!tpl.includes(token)) fail('template.html no longer contains ' + token + '.');
  }
  return tpl;
}

function renderPage(tpl, url, title, marker) {
  // template.html puts {{STREAM_URL}} inside an <iframe src="..."> tag, so we only
  // substitute the URL there and drop the re-resolve marker on its own line below it.
  let out = tpl
    .replace('{{TITLE}}', escapeHtml(title))
    .replace('{{STREAM_URL}}', url);
  const iframeLine = /(<iframe[^>]*?src="[^"]*"[^>]*><\/iframe>)/;
  if (iframeLine.test(out)) out = out.replace(iframeLine, '$1\n    ' + marker);
  else out = out + '\n' + marker;   // template shape changed — keep the marker valid HTML
  return out;
}

function upsertIndex(fileName, displayName) {
  if (!fs.existsSync(INDEX_FILE)) return 'manual';
  const index = fs.readFileSync(INDEX_FILE, 'utf8');
  const navStart = index.indexOf('<nav class="grid"');
  if (navStart === -1) return 'manual';
  const bodyStart = index.indexOf('>', navStart) + 1;
  const navEnd = index.indexOf('</nav>', bodyStart);
  if (navEnd === -1) return 'manual';

  const body = index.slice(bodyStart, navEnd);
  const entries = body.match(/\n\s*<a\b[\s\S]*?<\/a>/g) || [];
  const href = hrefFor(fileName);
  const sameFile = new RegExp('<a\\b[^>]*?href="' + href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i');
  const added = !entries.some(e => sameFile.test(e));
  const link = '<a href="' + href + '">' + escapeHtml(displayName) + '</a>';
  const next = entries.filter(e => !sameFile.test(e)).concat(added ? ['\n  ' + link] : []);
  const label = e => e.replace(/<[^>]+>/g, '').trim().toLowerCase();
  next.sort((a, b) => (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0));
  const rebuilt = '\n' + next.map(e => '  ' + e.trim()).join('\n') + '\n';
  fs.writeFileSync(INDEX_FILE, index.slice(0, bodyStart) + rebuilt + index.slice(navEnd));
  return added ? 'added' : 'updated';
}

/* -------------------------------- commands ----------------------------- */

async function cmdSports() {
  const sports = await getJson(`${API_BASE}/api/sports`);
  console.log('\nSport ids for --sport:');
  for (const s of sports) console.log('  ' + String(s.id).padEnd(20) + s.name);
  console.log('');
}

async function cmdList(opts) {
  const endpoint = listEndpoint(opts);
  const url = endpoint.startsWith('matches/')
    ? `${API_BASE}/api/${endpoint}`
    : `${API_BASE}/api/matches/${endpoint}`;
  const data = await getJson(url).catch(() => null);
  if (!Array.isArray(data)) fail('Could not load ' + url + '\n  List sport ids with: node streamed.js --sports');
  let rows = data;
  if (opts.search) {
    const q = String(opts.search).toLowerCase();
    rows = rows.filter(m => (m.title || '').toLowerCase().includes(q)
      || (m.id || '').toLowerCase().includes(q)
      || JSON.stringify(m.teams || {}).toLowerCase().includes(q));
  }
  const limit = opts.limit === true || opts.limit === undefined ? 25 : Number(opts.limit);
  console.log(`\n${rows.length} match(es) from ${url} — showing ${Math.min(limit, rows.length)}\n`);
  for (const m of rows.slice(0, limit)) {
    const srcs = (m.sources || []).map(s => `${s.source}/${s.id}`).join(' , ');
    console.log('  ' + (m.title || m.id).padEnd(46).slice(0, 46));
    console.log('      ' + fmtDate(m.date) + ' UTC · ' + (m.category || '-') + (m.popular ? ' · popular' : ''));
    console.log('      ' + (srcs || '(no sources)'));
  }
  console.log('\n  Next: node streamed.js --new <slug> --match <source/id> --name "<display name>"\n');
}

async function cmdEmbed(opts) {
  const arg = opts.embed === true ? opts._[0] : opts.embed;
  if (!arg) fail('--embed needs <source>/<id>, e.g. --embed delta/live-event_nascar...');
  const idx = String(arg).indexOf('/');
  const source = String(arg).slice(0, idx);
  const id = String(arg).slice(idx + 1);
  const list = await streams(source, id);
  if (!list.length) fail(`No streams returned for ${source}/${id} (match may not be listed any more).\n  Known-good fallback: ${iframeTag(embedUrlFor(source, id, 1))}`);
  const st = pickStream(list, opts);
  console.log('\nAvailable feeds:');
  for (const s of list) {
    console.log(`  #${s.streamNo}  ${(s.language || '-').padEnd(24)} ${s.hd ? 'HD' : 'SD'}  viewers:${s.viewers ?? '-'}  ${s.embedUrl || embedUrlFor(s.source, s.id, s.streamNo)}`);
  }
  const url = st.embedUrl || embedUrlFor(st.source, st.id, st.streamNo);
  console.log('\nPaste this between the "PASTE YOUR IFRAME" markers:\n');
  console.log('  ' + iframeTag(url));
  console.log('  ' + markerTag(source, id, '#stream=' + st.streamNo) + '\n');
}

async function cmdNew(opts) {
  const rawName = opts.new === true ? opts._[0] : opts.new;
  const fileName = slug(rawName);
  const target = path.join(ROOT, fileName);
  if (fs.existsSync(target) && !opts.force) fail(fileName + ' already exists. Use --force to rebuild it.');

  const matchArg = opts.match === true ? undefined : opts.match;
  const title = opts.name === true || opts.name === undefined
    ? pretty(fileName)
    : String(opts.name);

  let url, marker, note = '';
  if (matchArg && String(matchArg).includes('/')) {
    const v = String(matchArg);
    const source = v.slice(0, v.indexOf('/'));
    const id = v.slice(v.indexOf('/') + 1);
    const list = await streams(source, id);
    const st = pickStream(list, opts);
    if (st) {
      url = st.embedUrl || embedUrlFor(source, id, st.streamNo);
      note = `${st.language || '-'} · ${st.hd ? 'HD' : 'SD'}`;
    } else {
      // The event is listed but has no feeds yet (upcoming) or is off the stream list
      // (finished). The embed host still serves /embed/<source>/<id>/<n>, so build it.
      const n = opts.stream === true || opts.stream === undefined ? 1 : Number(opts.stream);
      url = embedUrlFor(source, id, n);
      note = 'feed not published yet — using the standard embed URL';
    }
    marker = markerTag(source, id, '#stream=' + (opts.stream && opts.stream !== true ? opts.stream : 1));
  }
  if (!url) {
    // Deterministic fallback: the embed host accepts /embed/<source>/<id>/<n> directly,
    // which keeps finished/upcoming events playable even when /api/stream lists nothing.
    if (!opts.source || !opts.id) {
      fail('Give --match <source>/<id> (see --list / --search), or --source <s> --id <id>.');
    }
    const n = opts.stream === true || opts.stream === undefined ? 1 : Number(opts.stream);
    url = embedUrlFor(String(opts.source), String(opts.id), n);
    marker = markerTag(String(opts.source), String(opts.id), '#stream=' + n);
  }

  const tpl = loadTemplate();
  fs.writeFileSync(target, renderPage(tpl, url, title, marker));
  const status = opts['no-index'] ? 'skipped' : upsertIndex(fileName, title);
  console.log('\n  ✓ Created ' + fileName);
  console.log('    title  : ' + title);
  console.log('    stream : ' + url + (note ? '  (' + note + ')' : ''));
  console.log('    marker : ' + marker);
  console.log('    index  : ' + status);
  console.log('\n  Commit & push, then GitHub Pages serves it in ~30–60 s:\n');
  console.log('    git add ' + fileName + ' index.html && git commit -m "Add ' + title + '" && git push');
  console.log('    node streamed.js --update ' + fileName.replace(/\.html$/i, '') + '   # refresh feed later\n');
}

async function cmdUpdate(opts) {
  const rawName = opts.update === true ? opts._[0] : opts.update;
  if (!rawName) fail('--update needs a channel slug, e.g. --update nascarsouthpoint');
  const fileName = slug(rawName);
  const target = path.join(ROOT, fileName);
  if (!fs.existsSync(target)) fail(fileName + ' does not exist.');
  const html = fs.readFileSync(target, 'utf8');
  const m = new RegExp('<!--\\s*' + MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^/]+)/([^ #]+)([^-]*)-->').exec(html);
  if (!m) fail('No "' + MARKER + '<source>/<id>' + '" marker found in ' + fileName + '. Re-create it with --new, or add the comment by hand.');
  const [, source, id, rest] = m;
  const list = await streams(source, id);
  if (!list.length) { console.log('  · ' + fileName + ': API returned no feeds for ' + source + '/' + id + ' — page left untouched.'); return; }
  const st = pickStream(list, opts);
  const url = st.embedUrl || embedUrlFor(source, id, st.streamNo);
  const marker = markerTag(source, id, '#stream=' + st.streamNo);
  const next = html
    .replace(/(<iframe[^>]*?\ssrc=")[^"]*(")/, '$1' + url + '$2')
    .replace(/<!--\s*streamed:[^>]*-->/, marker);
  fs.writeFileSync(target, next);
  console.log('\n  ✓ Updated ' + fileName);
  console.log('    stream : ' + url + `  (${st.language || '-'} · ${st.hd ? 'HD' : 'SD'})`);
  console.log('    feeds  : ' + list.map(s => '#' + s.streamNo + ' ' + (s.language || '-')).join(', ') + '\n');
}

function cmdChannels() {
  const files = channelFiles();
  console.log('\nPages using the Streamed API (' + files.filter(f => fs.readFileSync(path.join(ROOT, f), 'utf8').includes(MARKER)).length + ' of ' + files.length + '):\n');
  for (const f of files) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const mm = new RegExp(MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^ ]+)').exec(html);
    const src = (html.match(/<iframe[^>]*?\ssrc="([^"]+)"/) || [])[1] || '(none)';
    const tag = mm ? 'streamed→ ' + mm[1] : '';
    console.log('  ' + f.padEnd(32) + tag.padEnd(52) + src);
  }
  console.log('');
}

/* ---------------------------------- main -------------------------------- */

(async function main() {
  const opts = parseArgs(process.argv.slice(2));
  try {
    if (opts.sports) return await cmdSports();
    if (opts.channels) return cmdChannels();
    if (opts.embed) return await cmdEmbed(opts);
    if (opts.new) return await cmdNew(opts);
    if (opts.update) return await cmdUpdate(opts);
    if (opts.list || opts.search || opts.live || opts.sport || opts.all) return await cmdList(opts);
    console.log(`
  Streamed API helper — ${API_BASE}/docs

    node streamed.js --sports                     valid --sport ids
    node streamed.js --list [--sport football] [--live] [--limit N]
    node streamed.js --search "premier league"
    node streamed.js --embed <source>/<id> [--lang english] [--hd] [--stream 2]
    node streamed.js --new <slug> --match <source>/<id> --name "Display name" [--force]
    node streamed.js --update <slug> [--lang english] [--hd]
    node streamed.js --channels
`);
  } catch (e) {
    fail(e.message);
  }
})();
