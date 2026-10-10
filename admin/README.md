# Backend channel management (private)

The public `index.html` **no longer contains any "Add channel" form or token
logic** — visitors can only browse and search. Channels are added/removed from
this backend, and `index.html` updates automatically.

## Three ways to manage channels (pick whichever you like)

### A0. Double-click dashboard — NO npm, NO server ⭐ easiest

Just open this file in your browser by **double-clicking it** (or drag it into a browser window):

```
admin/index.html        ← local-only, git-ignored: it is NOT in the public repo
```

1. One time: revoke the old token that lived in the public browser page
   (<https://github.com/settings/tokens>) and create a **fresh fine-grained PAT**
   at <https://github.com/settings/personal-access-tokens/new>
   (*Only select repositories* → this repo; **Contents = Read and write** only).
2. In the dashboard: paste the token + owner/repo, click **💾 Save & verify**.
   It is stored in *this browser's* localStorage under the `file://` origin —
   never uploaded anywhere except api.github.com over HTTPS, never committed.
3. Add channels forever after: **paste the stream URL**, hit Enter.
   The dashboard commits `<channel>.html` (built from `template.html`,
   structure unchanged), `channels.json`, and regenerated `index.html`.
   GitHub Pages redeploys (~30–60 s) and the new card is live.
4. Remove channels with one click; **Forget token** wipes it anytime.
5. Keep a private backup of `admin/index.html` somewhere safe (Dropbox/USB) —
   since it's git-ignored, GitHub does not have a copy. Losing the file is
   harmless: nothing secret is inside it; just re-download or ask for a new copy.

(If your browser blocks `file://` pages from calling the GitHub API — rare — use A below.)

### A0-bis. PK API / Streamed embeds — REMOVED ✂

All `streamed.pk` API tooling and every `embed.st` / `embedindia.st` iframe that
came from it have been deleted from this repo:

* `streamed.js` (the streamed.pk client) — deleted
* `nascar-roval-400.html` (embed.st iframe) — deleted
* `sonyten3.html` (embedindia.st event link) — deleted; the channel was also
  removed from `channels.json` and `index.html`

Every remaining channel page uses its own direct stream embed (e.g.
`https://dlive.sx/cast/stream-NNN.php`). Nothing in this repo calls or references
`streamed.pk` anymore.

### A. Local dashboard via tiny server (needs Node, no install steps)

```bash
npm run admin          # = node admin/serve.js
# opens http://127.0.0.1:8787/admin/admin.html in your browser
```

1. First time: create a **fresh fine-grained PAT** at
   <https://github.com/settings/personal-access-tokens/new>
   (Repository access: *Only select repositories* → this repo;
   Permissions: **Contents = Read and write** only).
   Revoke the old one that lived in the public browser page:
   <https://github.com/settings/tokens> → delete it.
2. On the dashboard fill owner/repo, paste the token once, click
   **Save token (local only)**. It is stored in *this browser's* localStorage
   under origin `127.0.0.1` — never uploaded, never committed, invisible to
   your GitHub Pages site (different origin cannot read it).
3. Add channels forever after: type the name, **paste the stream URL**, hit
   **＋ Add channel & publish**. The dashboard talks straight to the GitHub
   API from your browser and commits three files in order:
   `<channel>.html` (built from `template.html`, structure unchanged),
   `channels.json`, and the regenerated `index.html`.
   GitHub Pages redeploys (~30–60 s) and the new card is live.
   *Everything the add-channel function needs — token, owner, repo, branch —
   is stored locally in this browser only (localStorage keys
   `channeladmin.token` / `channeladmin.cfg`). The public `channels.json` is
   rewritten without owner/repo values; the secret never leaves your machine.*
4. Remove channels with one click from the list; **Forget token** wipes it
   from the browser anytime.

Security notes:
* `admin/admin.html` and `admin/serve.js` contain **zero secrets** — anyone who
  downloads them from your repo sees an empty form that does nothing without a
  token. The server binds to `127.0.0.1` only, so it isn't reachable from your
  network either.
* For maximum paranoia use option B (vault-encrypted token) instead of
  localStorage; both coexist fine.

### B. Command line — encrypted vault token

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
