#!/usr/bin/env node
/*
 * admin/sync-index.js — BACKEND tool: rebuild index.html from channels.json.
 *
 * index.html's link grid is generated output — channels.json is the source of
 * truth. If you hand-edit channels.json (or a commit touched only one of the
 * two files), run this to bring index.html back in line, then it commits the
 * result so GitHub Pages updates automatically. The channel structure itself
 * (the <nav class="grid"> container and plain <a href> cards) never changes.
 *
 * Usage:
 *   node admin/sync-index.js            # regenerate locally + commit to GitHub
 *   node admin/sync-index.js --check    # report drift, change nothing
 *   node admin/sync-index.js --no-push  # local regeneration only
 */

'use strict';

const fs = require('fs');
const crypto = require('crypto');
const lib = require('./lib');

function hash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12); }

async function main() {
  const opts = lib.parseArgs(process.argv.slice(2));
  const data = lib.readChannelsJson();
  const channels = data.channels || [];
  const current = fs.readFileSync(lib.INDEX_FILE, 'utf8');
  const next = lib.regenerateIndexString(current, channels);

  if (current === next) {
    console.log('\n  \u2714 index.html already matches channels.json (' + channels.length + ' channels). No drift.\n');
    return;
  }
  console.log('\n  \u00b7 Drift detected: index.html grid != channels.json (' + channels.length + ' channels).');
  if (opts.check) {
    console.log('  Run without --check to fix it.\n');
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(lib.INDEX_FILE, next);
  console.log('  \u2714 Regenerated index.html from channels.json [' + hash(current) + ' -> ' + hash(next) + ']');

  if (opts['no-push']) { console.log('  \u00b7 --no-push: commit/push with git when ready.\n'); return; }

  const token = await lib.getToken();
  const cfg = lib.getRepoConfig();
  try {
    await lib.commitFile(token, cfg, 'index.html', next, 'Sync index.html with channels.json');
    console.log('  \u2714 Committed to ' + cfg.owner + '/' + cfg.repo + '@' + cfg.branch + ' — Pages redeploys in ~30-60 s.\n');
  } catch (e) {
    console.warn('\n  \u26a0 Remote commit failed: ' + e.message);
    console.warn('  Push manually:  git add index.html && git commit -m "Sync index.html" && git push\n');
    process.exitCode = 1;
  }
}

main().catch(e => lib.fail(e.message));
