#!/usr/bin/env node
/*
 * admin/tag-channel.js — BACKEND tool: manage the tags/classification system.
 *
 * channels.json entries may carry three OPTIONAL classification fields:
 *   sport  : list of canonical sport tags   (e.g. ["football","tennis"])
 *   region : country/region string          (e.g. "UK", "MENA")
 *   tags   : free-form extras               (e.g. ["premier league","hd"])
 * The public index.html grid is GENERATED from these fields (data-sport /
 * data-region / data-* attributes power the chip filters on the site). This
 * script edits the metadata and regenerates + commits everything atomically.
 *
 * Usage:
 *   node admin/tag-channel.js --list                       # all channels + tags
 *   node admin/tag-channel.js espnusa --sport "football,basketball,ufc" \
 *                             --region USA --tags "hd"
 *   node admin/tag-channel.js espnusa --clear              # remove all tags
 *
 * Options:
 *   --sport <a,b,c>     replace sport tags (aliases normalized: soccer->football)
 *   --region <name>     set region (empty string clears it)
 *   --tags <a,b,c>      replace free-form tags
 *   --clear             strip every classification field from the channel
 *   --list              print the current classification table and exit
 *   --no-push           update local files only (commit yourself via git)
 *   --dry-run           show what would happen; change nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const lib = require('./lib');

async function main() {
  const opts = lib.parseArgs(process.argv.slice(2));

  const data = lib.readChannelsJson();
  let channels = lib.setTags(data.channels || []);

  if (opts.list) {
    for (const c of channels.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const cls = lib.classifyChannel(c);
      console.log('  ' + c.file.padEnd(34) + (cls.sport ? 'sport=' + cls.sport.join(',') : '') +
                  (cls.region ? '  region=' + cls.region : '') + (cls.tags ? '  tags=' + cls.tags.join(',') : ''));
    }
    console.log('\n  sports in use: ' + lib.allSports(channels).join(', ') + '\n');
    return;
  }

  const rawTarget = opts._[0];
  if (!rawTarget) lib.fail('Missing channel (file or name). Use --list to see all, or --help above.');
  const targetFile = /\.html?$/i.test(rawTarget) ? lib.slug(rawTarget) : lib.slug(rawTarget) + '.html';
  let entry = channels.find(c => c.file === targetFile) ||
              channels.find(c => c.name.toLowerCase() === String(rawTarget).toLowerCase());
  if (!entry) lib.fail('No channel "' + rawTarget + '" in channels.json. Run: node admin/tag-channel.js --list');

  const meta = {};
  if (opts.clear) { meta.sport = []; meta.region = ''; meta.tags = []; }
  else {
    if (opts.sport !== undefined && opts.sport !== true) meta.sport = String(opts.sport);
    if (opts.region !== undefined && opts.region !== true) meta.region = String(opts.region);
    if (opts.tags !== undefined && opts.tags !== true) meta.tags = String(opts.tags);
    if (!Object.keys(meta).length) lib.fail('Nothing to change: pass --sport/--region/--tags or --clear.');
  }

  channels = lib.upsertChannelEntry(channels, entry.file, entry.name, meta);
  const updated = channels.find(c => c.file === entry.file);
  const cls = lib.classifyChannel(updated);
  console.log('\n  \u2713 ' + entry.name + ' -> ' +
    (cls.sport ? 'sport=' + cls.sport.join(',') + ' ' : '') +
    (cls.region ? 'region=' + cls.region + ' ' : '') +
    (cls.tags ? 'tags=' + cls.tags.join(',') : '(no tags)'));

  const nextIndex = lib.regenerateIndexString(fs.readFileSync(lib.INDEX_FILE, 'utf8'), channels);
  if (opts['dry-run']) { console.log('  [dry-run] No files changed.\n'); return; }

  data.channels = channels;
  lib.writeChannelsJson(data);
  fs.writeFileSync(lib.INDEX_FILE, nextIndex);
  console.log('  \u2714 Updated channels.json + regenerated index.html');

  if (opts['no-push']) { console.log('  \u00b7 --no-push: commit/push with git when ready.\n'); return; }

  const token = await lib.getToken();
  const cfg = lib.getRepoConfig();
  try {
    await lib.commitFiles(token, cfg, [
      { path: 'channels.json', content: JSON.stringify(data, null, 2) + '\n' },
      { path: 'index.html', content: nextIndex }
    ], 'Tags: ' + entry.file + ' (' + (cls.sport || []).join(',') + (cls.region ? '|' + cls.region : '') + ')');
    console.log('  \u2714 Committed to ' + cfg.owner + '/' + cfg.repo + '@' + cfg.branch + ' — Pages redeploys in ~30-60 s.\n');
  } catch (e) {
    console.warn('\n  \u26a0 Remote commit failed: ' + e.message);
    console.warn('  Local files are updated. Push manually:\n    git add channels.json index.html && git commit -m "Tags: ' + entry.file + '" && git push\n');
    process.exitCode = 1;
  }
}

main().catch(e => lib.fail(e.message));
