#!/usr/bin/env node
/*
 * new-channel.js — creates a new channel page from template.html
 *
 * Usage:
 *   node new-channel.js <channel-name> [options]
 *   node new-channel.js --list
 *   node new-channel.js --sync
 *
 * Examples:
 *   node new-channel.js skynewsitaly --url https://dlive.sx/cast/stream-123.php --title "Sky TG24 (Italy)"
 *   node new-channel.js espnz --url https://dlive.sx/cast/stream-55.php
 *   node new-channel.js oldname --rename newname        # rename a page and fix every link to it
 *   node new-channel.js --relink                        # rewrite every .html link across all pages
 *
 * Options:
 *   --url <iframe src>     stream URL for the player          (default: the template's sample URL)
 *   --title <page title>   browser-tab title        (default: the channel's display name)
 *   --name <display name>  label used on index.html          (default: prettified file name)
 *   --wm <url|none>        watermark image URL, or "none"    (default: keep the template's watermark)
 *   --size <percent>       watermark width, e.g. 18%         (default: keep template value)
 *   --op <opacity>         watermark opacity, e.g. .7        (default: keep template value)
 *   --channel-url <link>   WhatsApp channel link in the scrolling marquee under the player
 *   --channel-text <text>  marquee text shown next to that link
 *   --force                overwrite an existing page
 *   --no-index             do not add this channel to index.html
 *   --rename <new-name>    rename an existing page (no --url needed)
 *   --relink               rewrite every .html link in every page to its real file name
 *   --list                 list all channel pages
 *   --sync                 only refresh the index.html entry for this channel
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TEMPLATE_FILE = path.join(ROOT, 'template.html');
const INDEX_FILE = path.join(ROOT, 'index.html');
const RESERVED = ['index.html', 'template.html'];
const NEW_FILE = 'new.html';   // the blank template page every host can serve
const DEFAULT_STREAM_URL = 'https://dlive.sx/cast/stream-885.php';

/* ---------------------------- tiny argument parser --------------------------- */

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

/* ------------------------------- naming rules -------------------------------- */

// File names stay lowercase-alphanumeric plus - _ ( ) so links never need escaping.
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

// Sonyten1 -> "Sony Ten 1", beinsportsmena2(eng) -> "Beinsportsmena2 (eng)"
function pretty(fileName) {
  const base = fileName.replace(/\.html$/i, '');
  let out = base
    .replace(/([a-z])([A-Z])/g, '$1 $2')      // lowerUpper -> "lower Upper"
    .replace(/([A-Za-z])(\d)/g, '$1 $2')        // letterDigit -> "letter Digit"
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function hrefFor(fileName) {
  // Spaces / brackets in a file name are legal, but percent-encode them in the href to be safe.
  return encodeURI(fileName);
}

// Only touch paths that stay inside the repo folder — never ../ or absolute paths.
function isSafeLocal(target) {
  const decoded = decodeTarget(target);
  if (path.isAbsolute(decoded)) return false;
  const norm = path.normalize(decoded);
  return norm !== '..' && !norm.startsWith('..' + path.sep) && !norm.startsWith(path.sep);
}

/* ------------------------------ template engine ------------------------------ */

function loadTemplate() {
  if (!fs.existsSync(TEMPLATE_FILE)) {
    fail('template.html is missing from ' + ROOT + '. Restore it before creating channels.');
  }
  const tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  for (const token of ['{{TITLE}}', '{{STREAM_URL}}']) {
    if (!tpl.includes(token)) fail('template.html no longer contains ' + token + '. Keep those two placeholders intact.');
  }
  return tpl;
}

function applyOptions(html, opts) {
  const changes = [];

  if (opts.size !== undefined && opts.size !== true) {
    const size = String(opts.size).trim().replace('%', '') + '%';
    if (!/^(\d{1,2}(\.\d+)?|100)%$/.test(size)) fail('--size must be a percentage, e.g. 18%');
    html = html.replace(/--wm-size:\s*[^;]+;/, `--wm-size: ${size};`);
    changes.push('watermark size → ' + size);
  }

  if (opts.op !== undefined && opts.op !== true) {
    const op = parseFloat(opts.op);
    if (!(op > 0 && op <= 1)) fail('--op must be a number between 0 and 1, e.g. .7');
    html = html.replace(/--wm-opacity:\s*[^;]+;/, `--wm-opacity: ${String(opts.op).replace(/^0\./, '.')};`);
    changes.push('watermark opacity → ' + opts.op);
  }

  if (opts.wm !== undefined && opts.wm !== true) {
    if (String(opts.wm).toLowerCase() === 'none') {
      html = html.replace(/\n\s*<img class="wm"[^>]*>/, '');
      changes.push('watermark removed');
    } else {
      const url = String(opts.wm);
      if (!/^(https?:\/\/|\/|\.\.\/)/.test(url)) fail('--wm must be an http(s):// URL or a local path.');
      html = html.replace(/(<img class="wm" src=")[^"]*(")/, `$1${url}$2`);
      changes.push('watermark image → ' + url);
    }
  }

  // WhatsApp channel marquee (the scrolling bar under the player in the new template).
  if (opts['channel-url'] !== undefined && opts['channel-url'] !== true) {
    const link = String(opts['channel-url']).replace(/"/g, '&quot;');
    if (!/^(https?:)?\/\//.test(link)) fail('--channel-url must be a full https:// link.');
    const next = html.replace(/(const CHANNEL_URL\s*=\s*)"[^"]*"/, `$1"${link}"`);
    if (next === html) fail('Could not locate the "CHANNEL_URL" constant in template.html.');
    html = next;
    changes.push('marquee channel link → ' + link);
  }

  if (opts['channel-text'] !== undefined && opts['channel-text'] !== true) {
    const text = String(opts['channel-text']).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const next = html.replace(/(const CHANNEL_TEXT\s*=\s*)"[^"]*"/, `$1"${text}"`);
    if (next === html) fail('Could not locate the "CHANNEL_TEXT" constant in template.html.');
    html = next;
    changes.push('marquee text updated');
  }

  return { html, changes };
}

function render(tpl, opts) {
  // Default tab title = the channel's display name (same label used on index.html).
  const defaultTitle = opts._ && opts._[0] ? pretty(slug(opts._[0])) : 'Live';
  const title = opts.title === true || opts.title === undefined ? defaultTitle : String(opts.title);
  const url = opts.url === true || opts.url === undefined ? DEFAULT_STREAM_URL : String(opts.url);
  if (opts.url !== undefined && opts.url !== true) {
    if (!/^(https?:)?\/\//.test(url)) fail('--url must be a full stream URL starting with https://');
  }
  let html = tpl.replace('{{TITLE}}', escapeHtml(title)).replace('{{STREAM_URL}}', url);
  return { html, ...applyOptions(html, opts) };
}

/* -------------------------------- index.html -------------------------------- */

function upsertIndex(fileName, displayName) {
  if (!fs.existsSync(INDEX_FILE)) {
    console.warn('  ! index.html not found — skipping directory update. Add the link manually:');
    console.warn('    <a href="' + hrefFor(fileName) + '">' + escapeHtml(displayName) + '</a>');
    return 'skipped';
  }

  const index = fs.readFileSync(INDEX_FILE, 'utf8');
  const marker = '<nav class="grid" id="channels" aria-label="Channel list">';
  const start = index.indexOf(marker);
  if (start === -1) return 'manual';

  const bodyStart = index.indexOf('>', start) + 1;
  const end = index.indexOf('</nav>', bodyStart);
  if (end === -1) return 'manual';

  const body = index.slice(bodyStart, end);
  const entries = body.match(/\n\s*<a\b[\s\S]*?<\/a>/g) || [];

  if (fileName === NEW_FILE) return 'skipped';

  const href = hrefFor(fileName);
  const link = '<a href="' + href + '">' + escapeHtml(displayName) + '</a>';
  const sameFile = new RegExp('<a\\b[^>]*href="' + href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'i');

  let next = entries.filter(e => !sameFile.test(e));
  const added = !entries.some(e => sameFile.test(e));
  if (added) next = next.concat('\n  ' + link);

  // Sort by the visible label so the grid stays alphabetical as channels grow.
  const label = e => (e.replace(/<[^>]+>/g, '').trim().toLowerCase());
  next.sort((a, b) => (label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0));

  const rebuilt = '\n' + next.map(e => e.trim()).map(e => '  ' + e).join('\n') + '\n';
  const candidate = index.slice(0, bodyStart) + rebuilt + index.slice(end);

  fs.writeFileSync(INDEX_FILE, candidate);
  return added ? 'added' : 'updated';
}

/* --------------------------------- commands --------------------------------- */

function listChannels() {
  const files = channelFiles();
  if (!files.length) { console.log('No channel pages found.'); return; }
  console.log('\nChannel pages (' + files.length + '):');
  for (const f of files) {
    const url = (fs.readFileSync(path.join(ROOT, f), 'utf8').match(/<iframe[^>]*?\ssrc="([^"]+)"/) || [])[1] || '(no iframe src)';
    console.log('  ' + f.padEnd(34) + url);
  }
  console.log('');
}

function channelFiles() {
  if (!fs.existsSync(ROOT)) return [];
  return fs.readdirSync(ROOT)
    .filter(f => /\.html$/i.test(f) && !RESERVED.includes(f) && f !== NEW_FILE)
    .sort((a, b) => a.localeCompare(b));
}

/* --------------------------- link repair (--relink) -------------------------- */

// Maps a decoded link target onto a real file name on disk (case-insensitive).
function buildResolver(files) {
  const byLower = new Map();
  for (const f of files) byLower.set(f.toLowerCase(), f);
  return target => {
    const base = path.basename(String(target).replace(/\\/g, '/'));
    if (!/\.html?$/i.test(base)) return null;
    return byLower.get(base.toLowerCase()) || null;
  };
}

function decodeTarget(target) {
  const clean = target.split('#')[0].split('?')[0];
  try { return decodeURIComponent(clean); } catch (_) { return clean; }
}

function relink() {
  const all = fs.readdirSync(ROOT).filter(f => /\.html$/i.test(f));
  // new.html is a real, linkable page (the blank default page) even though it is not a channel,
  // so the resolver must know about it — otherwise --relink falsely flags its links as missing.
  const resolve = buildResolver(all);
  const byLower = new Map();
  for (const f of all) byLower.set(f.toLowerCase(), f);
  const resolveAny = target => {
    const base = path.basename(String(target).replace(/\\/g, '/'));
    return /\.html?$/i.test(base) ? (byLower.get(base.toLowerCase()) || null) : null;
  };
  let touched = 0, rewritten = 0, removed = 0;
  const notes = [];

  for (const file of all) {
    const original = fs.readFileSync(path.join(ROOT, file), 'utf8');

    // 1. Rewrite local link targets so they match the real file names on disk.
    let out = original;
    const isIndex = file === 'index.html';
    const navStart0 = isIndex ? out.indexOf('<nav class="grid"') : -1;
    const navEnd0 = navStart0 !== -1 ? out.indexOf('</nav>', navStart0) : -1;

    out = out.replace(/(<a\b[^>]*?\shref=")([^"]+)(")/gi, (m, pre, target, post) => {
      if (/^(https?:|data:|mailto:|\/\/)/i.test(target) || !isSafeLocal(target)) return m;
      const real = resolve(decodeTarget(target));
      if (!real) { notes.push('missing target in ' + file + ': ' + target); return m; }
      const want = hrefFor(real);
      if (want === target) return m;
      rewritten++;
      return pre + want + post;
    });

    // 2. The "New channel" entry must always exist and point at new.html. If it drifted or
    //    was removed by hand, --relink puts it back so the button never dead-ends.
    if (isIndex && navStart0 !== -1 && navEnd0 !== -1) {
      const bodyStart = out.indexOf('>', navStart0) + 1;
      const body = out.slice(bodyStart, out.indexOf('</nav>', bodyStart));
      if (!/<a\b[^>]*?\shref="new\.html"/i.test(body)) {
        const navEnd = out.indexOf('</nav>', bodyStart);
        out = out.slice(0, navEnd) + '  <a href="new.html" class="is-new">+ New channel</a>\n' + out.slice(navEnd);
        notes.push('restored the "+ New channel" entry in index.html');
        rewritten++;
      }
    }

    if (out !== original) { fs.writeFileSync(path.join(ROOT, file), out); touched++; }
  }

  console.log('\n  ✓ Relink: checked ' + all.length + ' pages, rewrote ' + rewritten + ' link(s), flagged ' + removed + '.');
  for (const n of notes) console.log('    · ' + n);
  console.log('');
}

/* ------------------------ blank page (new.html) ------------------------------ */

// "New channel" on index.html points at new.html. It is always template.html with the
// placeholders filled with the default values (title "Live", sample stream URL), so
// clicking it opens the exact default code — no {{TOKENS}} visible to the browser.
function renderDefaultPage() {
  const tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  return tpl
    .split('{{TITLE}}').join('Live')
    .split('{{STREAM_URL}}').join(DEFAULT_STREAM_URL);
}
function refreshNewPage(log = true) {
  let tpl;
  try { tpl = fs.readFileSync(TEMPLATE_FILE, 'utf8'); }
  catch (_) { return false; }
  const rendered = renderDefaultPage();
  const target = path.join(ROOT, NEW_FILE);
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === tpl) {
    if (log) console.log('  · ' + NEW_FILE + ' already matches template.html.');
    return false;
  }
  fs.writeFileSync(target, rendered);
  if (log) console.log('  ✓ ' + NEW_FILE + ' refreshed from template.html (the blank "click New channel" page).');
  return true;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.list) return listChannels();
  if (opts.relink) { relink(); return refreshNewPage(); }

  const rawName = opts._[0];
  if (!rawName) fail('Missing channel name.\n\n  Usage: node new-channel.js <channel-name> --url <stream-url>\n         node new-channel.js --list');

  const fileName = slug(rawName);
  const target = path.join(ROOT, fileName);

  /* ---- rename ---- */
  if (opts.rename !== undefined && opts.rename !== true) {
    const newName = slug(String(opts.rename));
    if (newName === fileName) fail('New name equals the current name.');
    if (!fs.existsSync(target)) fail('Cannot rename: ' + fileName + ' does not exist.');
    if (fs.existsSync(path.join(ROOT, newName))) fail('Cannot rename: ' + newName + ' already exists.');
    fs.renameSync(target, path.join(ROOT, newName));
    const display = opts.name === true || opts.name === undefined ? pretty(newName) : String(opts.name);
    const status = upsertIndex(newName, display);
    relink();   // rewrite every reference to the old file name across all pages
    refreshNewPage();
    console.log('\n  ✓ Renamed ' + fileName + ' → ' + newName);
    console.log('  ✓ index.html: ' + describe(status, display) + ' (all links repaired by --relink)\n');
    return;
  }

  /* ---- create / sync ---- */
  const exists = fs.existsSync(target);
  if (exists && !opts.force && !opts.sync) {
    fail(fileName + ' already exists. Re-run with --force to rebuild it from the template, or --sync to only refresh its index.html entry.');
  }

  const display = opts.name === true || opts.name === undefined ? pretty(fileName) : String(opts.name);

  if (!opts.sync) {
    const tpl = loadTemplate();
    const { html, changes } = render(tpl, opts);
    fs.writeFileSync(target, html);
    console.log('\n  ✓ Created ' + fileName + ' from template.html');
    console.log('    title   : ' + (opts.title === true || opts.title === undefined ? pretty(fileName) : String(opts.title)));
    console.log('    stream  : ' + (opts.url === true || opts.url === undefined ? DEFAULT_STREAM_URL + '  (template default — edit it!)' : String(opts.url)));
    for (const c of changes) console.log('    tweak   : ' + c);
    if (opts.url === undefined) {
      console.log('\n  ⚠ No --url given, so the page plays the template\'s sample stream. Edit the line between the "PASTE YOUR IFRAME" markers.');
    }
  } else {
    if (!exists) fail('Cannot sync: ' + fileName + ' does not exist yet. Create it first.');
    console.log('  · Synced index entry only (' + fileName + ' left untouched).');
  }

  if (opts['no-index']) { console.log(''); return; }

  const status = upsertIndex(fileName, display);
  console.log('  ' + (status === 'manual' ? '! ' : '✓ ') + 'index.html: ' + describe(status, display));
  if (status === 'manual') {
    console.log('    index.html has no recognisable channel grid. Add this link by hand:');
    console.log('    <a href="' + hrefFor(fileName) + '">' + escapeHtml(display) + '</a>');
  }
  console.log('');
  refreshNewPage();
}

function describe(status, what) {
  return { added: 'added "' + what + '"', updated: 'refreshed "' + what + '"', skipped: 'skipped', manual: 'needs a manual link' }[status] || status;
}

main();
