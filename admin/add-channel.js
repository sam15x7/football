#!/usr/bin/env node
/*
 * admin/add-channel.js — BACKEND tool: add a channel and auto-update index.html.
 *
 * The public index.html no longer contains any "add channel" form or token
 * logic. You (the owner) add channels from this script only. It:
 *   1. builds <file>.html from template.html (channel structure unchanged),
 *   2. registers it in channels.json (the single source of truth),
 *   3. regenerates the <nav> link list inside index.html,
 *   4. commits all three files to GitHub with your ENCRYPTED fine-grained PAT
 *      (admin/token.enc — see admin/setup-token.js). GitHub Pages then
 *      redeploys automatically (~30-60 s) and the new card is live.
 *
 * Usage:
 *   node admin/add-channel.js <name> --url https://.../stream.php [options]
 *   node admin/add-channel.js skynewsitaly --url https://dlive.sx/cast/stream-123.php \
 *        --title "Sky TG24 (Italy)" --name "Sky TG24 (Italy)"
 *
 * Options:
 *   --url <stream-url>     iframe src for the player            (required)
 *   --title <page title>   browser-tab title    (default: display name)
 *   --name <display name>  label on index.html  (default: prettified file name)
 *   --file <x.html>        explicit file name   (default: slug of <name>)
 *   --force                overwrite an existing channel page
 *   --no-push              update local files only (commit yourself via git)
 *   --dry-run              show what would happen; change nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

async function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  const rawName = opts._[0];
  if (!rawName) {
    lib.fail('Missing channel name.\n\n  Usage: node admin/add-channel.js <name> --url <stream-url>\n' +
             '  Example: node admin/add-channel.js espn4argentina --url https://dlive.sx/cast/stream-900.php --name "ESPN 4 (Argentina)"');
  }
  if (opts.url === undefined || opts.url === true) {
    lib.fail('Missing --url <stream-url>. Every channel page needs its iframe src.');
  }
  const streamUrl = String(opts.url);
  if (!/^(https?:)?\/\//i.test(streamUrl)) lib.fail('--url must be a full stream URL starting with https://');

  const fileName = opts.file && opts.file !== true ? lib.slug(String(opts.file)) : lib.slug(rawName);
  if (/^(index|template|new)\.html$/i.test(fileName)) lib.fail('That file name is reserved.');
  const target = path.join(lib.ROOT, fileName);
  if (fs.existsSync(target) && !opts.force && !opts['dry-run']) {
    lib.fail(fileName + ' already exists. Re-run with --force to rebuild it, or pick another name.');
  }

  const display = opts.name && opts.name !== true ? String(opts.name) : lib.pretty(fileName);
  const title = opts.title && opts.title !== true ? String(opts.title) : display;

  // 1) the channel page (same structure as every other channel)
  const page = lib.buildPage(title, streamUrl);

  // 2) channels.json registry + 3) regenerated index.html
  const data = lib.readChannelsJson();
  data.channels = lib.upsertChannelEntry(data.channels || [], fileName, display);
  const nextIndex = lib.regenerateIndexString(fs.readFileSync(lib.INDEX_FILE, 'utf8'), data.channels);

  if (opts['dry-run']) {
    console.log('\n  [dry-run] Would create ' + fileName + ' ("' + display + '", ' + streamUrl + ')');
    console.log('  [dry-run] Would register it in channels.json');
    console.log('  [dry-run] Would regenerate the index.html link grid (' + data.channels.length + ' links)\n');
    return;
  }

  fs.writeFileSync(target, page);
  lib.writeChannelsJson(data);
  fs.writeFileSync(lib.INDEX_FILE, nextIndex);
  console.log('\n  \u2714 Created ' + fileName + ' from template.html');
  console.log('  \u2714 Registered in channels.json');
  console.log('  \u2714 Regenerated index.html (' + data.channels.length + ' channel links)');

  if (opts['no-push']) { console.log('  \u00b7 --no-push: commit/push with git when ready.\n'); return; }

  // 4) push to GitHub so Pages redeploys and index.html updates automatically
  const token = await lib.getToken();
  const cfg = lib.getRepoConfig();
  try {
    await lib.commitFile(token, cfg, fileName, page, 'Add channel: ' + display);
    await lib.commitFile(token, cfg, 'channels.json', JSON.stringify(data, null, 2) + '\n', 'Register channel: ' + display);
    await lib.commitFile(token, cfg, 'index.html', nextIndex, 'Index: add ' + display);
    console.log('  \u2714 Committed to ' + cfg.owner + '/' + cfg.repo + '@' + cfg.branch +
                ' — GitHub Pages will show the new card in ~30-60 s.\n');
  } catch (e) {
    console.warn('\n  \u26a0 Remote commit failed: ' + e.message);
    console.warn('  Local files are updated. Push manually with:\n' +
                 '    git add "' + fileName + '" channels.json index.html && git commit -m "Add channel: ' + display + '" && git push\n');
    console.warn('  Or retry with GH_TOKEN exported / the vault passphrase correct.\n');
    process.exitCode = 1;
  }
}

main().catch(e => lib.fail(e.message));
