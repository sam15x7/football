#!/usr/bin/env node
/*
 * admin/remove-channel.js — BACKEND tool: remove a channel and auto-update index.html.
 *
 * Deletes the channel page, unregisters it from channels.json, regenerates the
 * index.html link grid, and commits all three changes with your encrypted PAT.
 *
 * Usage:
 *   node admin/remove-channel.js <name-or-file> [--dry-run] [--no-push]
 *   node admin/remove-channel.js espn4argentina
 *   node admin/remove-channel.js beinsportsmena2\(eng\) --no-push
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

async function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  const rawName = opts._[0];
  if (!rawName) lib.fail('Usage: node admin/remove-channel.js <name-or-file>');

  const fileName = /\.html$/i.test(rawName) ? rawName : lib.slug(rawName);
  if (/^(index|template|new)\.html$/i.test(fileName)) lib.fail('That file name is reserved.');
  const target = path.join(lib.ROOT, fileName);

  const data = lib.readChannelsJson();
  const before = (data.channels || []).length;
  data.channels = lib.removeChannelEntry(data.channels || [], fileName);
  if ((data.channels || []).length === before && !fs.existsSync(target)) {
    lib.fail('No channel named ' + fileName + ' in channels.json or on disk.');
  }
  const nextIndex = lib.regenerateIndexString(fs.readFileSync(lib.INDEX_FILE, 'utf8'), data.channels);

  if (opts['dry-run']) {
    console.log('\n  [dry-run] Would delete ' + fileName + ', unregister it, regenerate index.html (' + data.channels.length + ' links)\n');
    return;
  }

  if (fs.existsSync(target)) fs.unlinkSync(target);
  lib.writeChannelsJson(data);
  fs.writeFileSync(lib.INDEX_FILE, nextIndex);
  console.log('\n  \u2714 Deleted ' + fileName);
  console.log('  \u2714 Updated channels.json and index.html (' + data.channels.length + ' links)');

  if (opts['no-push']) { console.log('  \u00b7 --no-push: commit/push with git when ready.\n'); return; }

  const token = await lib.getToken();
  const cfg = lib.getRepoConfig();
  try {
    // Delete the page via the Contents API (needs the current sha).
    const cur = await lib.fetchRemoteFile(token, cfg, fileName);
    if (cur.exists) {
      const r = await fetch('https://api.github.com/repos/' + encodeURIComponent(cfg.owner) + '/' +
        encodeURIComponent(cfg.repo) + '/contents/' + encodeURIComponent(fileName) +
        '?ref=' + encodeURIComponent(cfg.branch), {
        method: 'DELETE',
        headers: {
          Authorization: 'token ' + token,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'channel-admin'
        },
        body: JSON.stringify({ message: 'Remove channel: ' + fileName, sha: cur.sha, branch: cfg.branch })
      });
      if (!r.ok) throw new Error('GitHub delete failed (' + r.status + ') for ' + fileName + ': ' + (await r.text()).slice(0, 200));
    }
    await lib.commitFile(token, cfg, 'channels.json', JSON.stringify(data, null, 2) + '\n', 'Unregister channel: ' + fileName);
    await lib.commitFile(token, cfg, 'index.html', nextIndex, 'Index: remove ' + fileName);
    console.log('  \u2714 Committed to ' + cfg.owner + '/' + cfg.repo + '@' + cfg.branch + ' — Pages redeploys in ~30-60 s.\n');
  } catch (e) {
    console.warn('\n  \u26a0 Remote commit failed: ' + e.message);
    console.warn('  Local files are updated. Push manually:\n' +
                 '    git add -A channels.json index.html "' + fileName + '" && git commit -m "Remove channel: ' + fileName + '" && git push\n');
    process.exitCode = 1;
  }
}

main().catch(e => lib.fail(e.message));
