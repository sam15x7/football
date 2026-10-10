# Backend channel management (private)

The public `index.html` **no longer contains any "Add channel" form or token
logic** — visitors can only browse and search. Channels are added/removed from
this backend, and `index.html` updates automatically.

## How it works

```
channels.json  ──(source of truth: file + display name per channel)──▶  index.html
      ▲                                                                  (GENERATED link grid)
      │
admin/add-channel.js / remove-channel.js / sync-index.js
      │  builds <name>.html from template.html   (channel structure unchanged)
      └─ commits channels page + channels.json + regenerated index.html
         to GitHub using your ENCRYPTED fine-grained PAT
         → GitHub Pages redeploys (~30–60 s) → new card is live.
```

* `template.html`, every channel `.html` page, and the `<nav class="grid">`
  card structure in `index.html` are exactly as before — nothing about a
  channel's structure changed.
* The old browser-side `add-channel.js` was deleted; no token handling exists
  anywhere in public files anymore.

## One-time setup — encrypted GitHub token

1. Create a **fine-grained** PAT: <https://github.com/settings/personal-access-tokens/new>
   * Repository access: *Only select repositories* → this repo only
   * Permissions: **Contents = Read and write** (nothing else)
2. Fill `"owner"`, `"repo"`, `"branch"` in `channels.json` (or just add a
   GitHub remote to your clone — the scripts auto-detect owner/repo).
3. Store the token **encrypted**:

   ```bash
   node admin/setup-token.js
   # paste the PAT, choose a vault passphrase (min 8 chars)
   ```

   The token is saved at `admin/token.enc`, encrypted with **AES-256-GCM**
   (key derived via scrypt). The passphrase is never stored on disk — you type
   it each time an admin script runs. Both `admin/token.enc` and the optional
   plaintext fallback `.github-token` are git-ignored, so the secret never
   reaches GitHub's scanner or your public site.

   Verify anytime: `node admin/setup-token.js --check`
   Replace the token: `node admin/setup-token.js --rotate`

   CI alternative: export `GH_TOKEN` (skips the vault), or `GH_PASSPHRASE` +
   commit `token.enc` nowhere.

## Daily commands

```bash
# Add a channel (creates xyzchannel.html, registers it, regenerates index.html, pushes)
node admin/add-channel.js espn4argentina \
     --url https://dlive.sx/cast/stream-900.php \
     --name "ESPN 4 (Argentina)"
# extras: --title <tab title>  --file <explicit.html>  --force  --no-push  --dry-run

# Remove a channel
node admin/remove-channel.js espn4argentina

# Rebuild index.html from channels.json (after hand-editing the JSON, etc.)
node admin/sync-index.js          # fix drift + push
node admin/sync-index.js --check  # report drift only
```

npm aliases (once `npm install` is run, though there are zero dependencies):

```bash
npm run channel:add -- espn4argentina --url https://…
npm run channel:remove -- espn4argentina
npm run index:sync
```

## Rules

* Never edit the link list inside `index.html` by hand — change
  `channels.json` and run `node admin/sync-index.js`.
* Never put a token in `channels.json` or any committed file.
* If a remote commit fails, the local files are already correct — just
  `git add … && git commit && git push`.
