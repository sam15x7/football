#!/usr/bin/env node
/*
 * admin/setup-token.js — one-time (or --rotate) setup of your GitHub
 * fine-grained PAT for the backend channel-admin scripts.
 *
 * The token is stored ENCRYPTED at rest:
 *   admin/token.enc  =  AES-256-GCM( token, key = scrypt(passphrase) )
 * The passphrase is never written to disk — you type it every time an admin
 * script needs the token (or export GH_TOKEN to bypass the vault entirely).
 *
 * Create a fine-grained PAT at:
 *   https://github.com/settings/personal-access-tokens/new
 *     - Repository access: "Only select repositories" -> THIS repo only
 *     - Permissions: Contents = Read and write
 *
 * Usage:
 *   node admin/setup-token.js            # prompt for token + passphrase, save vault
 *   node admin/setup-token.js --rotate   # same, overwriting the old vault
 *   node admin/setup-token.js --check    # decrypt vault & verify token against GitHub
 */

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const lib = require('./lib');

const VAULT = lib.VAULT_FILE;

function askVisible(question) {
  return new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, ans => { rl.close(); res(ans); });
  });
}

async function main() {
  const opts = lib.parseArgs(process.argv.slice(2));

  if (opts.check) {
    if (!fs.existsSync(VAULT)) lib.fail('No vault yet. Run: node admin/setup-token.js');
    const pass = await lib.readPassphraseFromTTY('Vault passphrase: ');
    const token = lib.decryptToken(fs.readFileSync(VAULT), pass);
    const cfg = lib.getRepoConfig();
    const r = await fetch('https://api.github.com/repos/' + cfg.owner + '/' + cfg.repo, {
      headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'channel-admin' }
    });
    if (r.ok) console.log('\n  \u2714 Token is valid and can see ' + cfg.owner + '/' + cfg.repo + '\n');
    else console.log('\n  \u2717 Token decrypted OK, but GitHub replied ' + r.status + '. Check the PAT has "Contents: Read and write" on this repo.\n');
    return;
  }

  if (fs.existsSync(VAULT) && !opts.rotate) {
    lib.fail('admin/token.enc already exists. Use --rotate to replace it.');
  }

  console.log('\nPaste a GitHub FINE-GRAINED personal access token');
  console.log('(Contents: Read and write, limited to this repository only).\n');
  const token = (await askVisible('Token: ')).trim();
  if (!/^github_pat_|^gh[purs]_/i.test(token)) {
    const ok = (await askVisible('That does not look like a GitHub token. Save anyway? [y/N]: ')).trim().toLowerCase();
    if (ok !== 'y') lib.fail('Cancelled - nothing was saved.');
  }
  const p1 = await lib.readPassphraseFromTTY('Choose a vault passphrase (min 8 chars): ');
  if (p1.length < 8) lib.fail('Passphrase too short (need at least 8 characters).');
  const p2 = await lib.readPassphraseFromTTY('Repeat passphrase: ');
  if (p1 !== p2) lib.fail('Passphrases did not match.');

  const buf = lib.encryptToken(token, p1);
  fs.mkdirSync(path.dirname(VAULT), { recursive: true });
  fs.writeFileSync(VAULT, buf, { mode: 0o600 });
  try { fs.chmodSync(VAULT, 0o600); } catch (_) {}

  // sanity: round-trip verification
  const back = lib.decryptToken(buf, p1);
  if (back !== token) lib.fail('Vault verification failed - nothing was saved.');

  console.log('\n  \u2714 Saved encrypted vault: admin/token.enc (AES-256-GCM)');
  console.log('  \u2714 The file is git-ignored; the passphrase was never stored anywhere.');
  console.log('  Next: node admin/add-channel.js <name> --url <stream-url>\n');
}

main().catch(e => lib.fail(e.message));
