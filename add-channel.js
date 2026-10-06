/* add-channel.js — powers the "+ Add channel" form on index.html.
 *
 * What it does (all in the browser, no server needed):
 *   1. Builds a brand-new channel page from template.html (your exact default code).
 *   2. Commits it to your GitHub repo via the GitHub Contents API as xyzchannel.html.
 *   3. Updates channels.json + index.html in the same repo so the new link appears.
 *   4. Once GitHub Pages rebuilds (~30–60 s), the card is live on your site.
 *
 * One-time setup — NO secrets are ever committed to this repo:
 *   1. In channels.json set "owner", "repo" and "branch" only (leave "token" empty).
 *   2. Create a fine-grained Personal Access Token at
 *      https://github.com/settings/personal-access-tokens/new
 *        - Repository access: "Only select repositories" → THIS repo only
 *        - Permissions: Contents = Read and write
 *   3. On your live site click "+ Add channel" → "🔑 Set token". The token is saved
 *      ONLY in this browser (localStorage); GitHub's secret scanner never sees it.
 *      You must repeat step 3 once per device/browser you add channels from.
 *
 * If the repo is PRIVATE, owner/repo/branch can also be detected automatically from
 * the GitHub web URL (…/<owner>/<repo>/blob/<branch>/index.html), so channels.json
 * needs no values at all.
 */
(function () {
  "use strict";

  var CONFIG_URL = "channels.json";
  var TEMPLATE_URL = "template.html";
  var INDEX_URL = "index.html";
  var TOKEN_KEY = "ghAddChannelToken"; // token lives only in this browser

  var btn, form, titleEl, urlEl, fileEl, statusEl, tokenBtn;
  var cfg = null, tpl = null;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }
  function setToken(t) {
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  }

  // When served from github.com itself, infer owner/repo/branch from the URL.
  function guessFromLocation() {
    var m = /^\/([^\/?#]+)\/([^\/?#]+)\/blob\/([^\/?#]+)/.exec(location.pathname);
    if (!m) return {};
    return { owner: m[1], repo: m[2], branch: decodeURIComponent(m[3]) };
  }

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function $(id) { return document.getElementById(id); }

  function show(msg, kind) {
    statusEl.textContent = msg;
    statusEl.className = "form-status" + (kind ? " " + kind : "");
    statusEl.hidden = false;
  }

  function apiBase() {
    return "https://api.github.com/repos/" +
      encodeURIComponent(cfg.owner) + "/" + encodeURIComponent(cfg.repo);
  }

  function ghHeaders(etag) {
    var h = {
      "Authorization": "token " + (getToken() || (cfg && cfg.token) || ""),
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (etag) h["If-None-Match"] = etag;
    return h;
  }

  // GitHub returns 404 (not 409) for missing files; sha param handles create-vs-update.
  async function fetchFile(path) {
    var r = await fetch(apiBase() + "/contents/" + encodeURIComponent(path) +
      "?ref=" + encodeURIComponent(cfg.branch || "main"), { headers: ghHeaders() });
    if (r.status === 404) return { exists: false, sha: null, content: null };
    if (!r.ok) throw new Error("GitHub read failed (" + r.status + ") for " + path +
      ". Check owner/repo/token in channels.json.");
    var j = await r.json();
    return {
      exists: true,
      sha: j.sha,
      content: j.content
        ? decodeURIComponent(escape(atob(j.content.replace(/\n/g, ""))))
        : ""
    };
  }

  async function putFile(path, content, message) {
    var cur = await fetchFile(path);
    var body = {
      message: message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch: cfg.branch || "main"
    };
    if (cur.exists) body.sha = cur.sha;
    var r = await fetch(apiBase() + "/contents/" + encodeURIComponent(path), {
      method: "PUT",
      headers: ghHeaders(),
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      var t = await r.text();
      throw new Error("GitHub write failed (" + r.status + ") for " + path + ": " + t.slice(0, 200));
    }
    return r.json();
  }

  function slugify(name) {
    return name.toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "channel";
  }

  function buildPage(title, streamUrl) {
    // Fill the {{TITLE}} / {{STREAM_URL}} tokens of template.html.
    // Escape into the HTML attribute/text contexts they appear in.
    return tpl
      .replace(/\{\{TITLE\}\}/g, esc(title))
      .replace(/\{\{STREAM_URL\}\}/g, streamUrl.replace(/"/g, "%22"));
  }

  function upsertIndexLinks(indexHtml, file, name) {
    // Insert (or replace) the <a href="file">Name</a> line before the closing </nav>.
    var navStart = indexHtml.indexOf('<nav class="grid"');
    var navEnd = indexHtml.indexOf("</nav>");
    if (navStart === -1 || navEnd === -1) throw new Error("Could not find channel grid in index.html.");
    var inner = indexHtml.slice(navStart, navEnd);
    // Remove any previous entry pointing at the same file.
    inner = inner.replace(new RegExp('\\s*<a href="' + file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '">[^<]*</a>', "g"), "");
    inner += '\n  <a href="' + file + '">' + esc(name) + "</a>";
    return indexHtml.slice(0, navStart) + inner + indexHtml.slice(navEnd);
  }

  /* ---------- main flow ---------- */

  async function submitForm(e) {
    e.preventDefault();
    var title = titleEl.value.trim();
    var stream = urlEl.value.trim();
    var file = fileEl.value.trim().toLowerCase();

    // validation
    if (!title) return show("Enter the channel title.", "err");
    if (!/^https?:\/\//i.test(stream)) return show("Stream URL must start with http:// or https://", "err");
    if (!file) file = slugify(title) + ".html";
    if (!/^[a-z0-9._-]+\.html$/.test(file)) return show("File name may use letters, numbers, dots, dashes and must end in .html", "err");
    if (/^(index|new|template)\.html$/.test(file)) return show("That file name is reserved.", "err");

    if (!cfg || !cfg.owner || !cfg.repo) {
      return show('Not configured yet. Edit channels.json in this repo: set "owner" and "repo".', "err");
    }
    if (!getToken()) {
      return show("No token saved in this browser yet. Click “🔑 Set token” above the form and paste a fine-grained PAT (Contents: Read & write, this repo only). It is stored locally — never committed.", "err");
    }

    btn.disabled = true;
    show("Creating " + file + " …", "");

    try {
      if (!tpl) tpl = (await fetchFile(TEMPLATE_URL)).content;
      if (!tpl || tpl.indexOf("{{TITLE}}") === -1) throw new Error("template.html missing or corrupted.");

      var page = buildPage(title, stream);

      // Refuse to silently overwrite an existing channel.
      var existing = await fetchFile(file);
      if (existing.exists && existing.content && existing.content.indexOf(page) !== 0) {
        if (!confirm(file + " already exists in the repo. Overwrite it?")) {
          btn.disabled = false; show("Cancelled — nothing was changed.", "");
          return;
        }
      }

      // 1) the channel page itself
      await putFile(file, page, "Add channel: " + title);

      // 2) channels.json registry (best effort — never blocks the page creation)
      try {
        var cj = await fetchFile(CONFIG_URL);
        var data = cj.exists && cj.content ? JSON.parse(cj.content) : {};
        data.channels = data.channels || [];
        data.channels = data.channels.filter(function (c) { return c.file !== file; });
        data.channels.push({ file: file, name: title });
        await putFile(CONFIG_URL, JSON.stringify(data, null, 2) + "\n", "Register channel: " + title);
      } catch (err2) { console.warn("channels.json update skipped:", err2); }

      // 3) index.html link
      var idx = await fetchFile(INDEX_URL);
      if (!idx.exists) throw new Error("index.html not found in the repo.");
      await putFile(INDEX_URL, upsertIndexLinks(idx.content, file, title), "Index: add " + title);

      show("✔ Done! " + file + " committed. The link appears on this page after GitHub Pages redeploys (~30–60 s).", "ok");
      form.reset();
      setTimeout(function () { location.reload(); }, 4000);
    } catch (err) {
      show("Error: " + err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------- UI ---------- */

  function injectUI() {
    var header = document.querySelector("header");
    if (!header) return;

    btn = document.createElement("button");
    btn.type = "button";
    btn.id = "btnAdd";
    btn.className = "btn-new btn-add";
    btn.textContent = "+ Add channel";
    header.querySelector(".head-tools").appendChild(btn);

    var wrap = document.createElement("div");
    wrap.id = "addWrap";
    wrap.className = "add-wrap";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="token-bar">' +
      '  <button type="button" id="btnToken" class="btn-new btn-token">🔑 Set token</button>' +
      '  <span id="tokenState" class="token-state"></span>' +
      "</div>" +
      '<form id="addForm" class="add-form" novalidate>' +
      '  <label>Title<input id="fTitle" type="text" placeholder="e.g. ESPN 4 (Argentina)" required></label>' +
      '  <label>Stream URL<input id="fUrl" type="url" placeholder="https://…/stream.php" required></label>' +
      '  <label>File name<input id="fFile" type="text" placeholder="auto: espn4argentina.html"></label>' +
      '  <div class="add-actions"><button type="submit" class="btn-new btn-submit">Create &amp; save to GitHub</button>' +
      '  <button type="button" class="btn-new btn-cancel">Cancel</button></div>' +
      '  <p class="form-status" id="fStatus" hidden></p>' +
      "</form>";
    btn.parentNode.insertBefore(wrap, btn.nextSibling);

    form = $("addForm");
    titleEl = $("fTitle");
    urlEl = $("fUrl");
    fileEl = $("fFile");
    statusEl = $("fStatus");
    tokenBtn = $("btnToken");

    function refreshTokenState() {
      var has = !!getToken();
      $("tokenState").textContent = has
        ? "Token saved in this browser ✔ (never committed)"
        : "No token yet — click the button and paste a fine-grained PAT";
      $("tokenState").className = "token-state " + (has ? "ok" : "warn");
      tokenBtn.textContent = has ? "🔑 Change / clear token" : "🔑 Set token";
    }
    tokenBtn.addEventListener("click", function () {
      var cur = getToken();
      var v = prompt(
        "Paste your GitHub fine-grained Personal Access Token.\n" +
        "(Contents: Read & write, limited to THIS repo)\n\n" +
        "It is stored ONLY in this browser's localStorage — never in the repo.\n" +
        "Leave empty and press OK to clear it.",
        cur ? "" : "");
      if (v === null) return;
      setToken(v.trim());
      refreshTokenState();
      if (v.trim()) show("Token saved locally. You can now add channels from this browser.", "ok");
    });
    refreshTokenState();

    btn.addEventListener("click", function () {
      wrap.hidden = !wrap.hidden;
      if (!wrap.hidden) titleEl.focus();
    });
    wrap.querySelector(".btn-cancel").addEventListener("click", function () { wrap.hidden = true; });
    form.addEventListener("submit", submitForm);
    titleEl.addEventListener("input", function () {
      if (!fileEl.dataset.touched) fileEl.placeholder = "auto: " + slugify(titleEl.value || "channel") + ".html";
    });
    fileEl.addEventListener("input", function () { fileEl.dataset.touched = "1"; });

    var style = document.createElement("style");
    style.textContent =
      ".btn-add { cursor:pointer; font:inherit; background:transparent; }\n" +
      ".token-bar { display:flex; align-items:center; gap:12px; margin-bottom:10px; flex-wrap:wrap; }\n" +
      ".btn-token { border-color:#d4af37; color:#d4af37; font-size:13px; padding:6px 12px; }\n" +
      ".token-state { font-size:13px; color:#8a838f; }\n" +
      ".token-state.ok { color:#a5d6a7; } .token-state.warn { color:#e6c07b; }\n" +
      ".add-wrap { max-width:1100px; margin:0 auto 20px; }\n" +
      ".add-form { display:grid; gap:12px; background:#121013; border:1px solid #2b262d; border-radius:8px; padding:16px; }\n" +
      ".add-form label { display:grid; gap:6px; font-size:13px; color:#8a838f; letter-spacing:.03em; }\n" +
      ".add-form input { padding:9px 12px; font:500 15px Barlow, sans-serif; color:#ece6d6; background:#09080a; border:1px solid #2b262d; border-radius:6px; }\n" +
      ".add-form input:focus-visible { outline:2px solid #d4af37; outline-offset:1px; }\n" +
      ".add-actions { display:flex; gap:10px; }\n" +
      ".btn-submit { border-color:#d4af37; color:#d4af37; }\n" +
      ".form-status { font-size:14px; margin:0; white-space:pre-wrap; }\n" +
      ".form-status.err { color:#e57373; } .form-status.ok { color:#a5d6a7; }";
    document.head.appendChild(style);
  }

  // On GitHub Pages the site is served from https://<owner>.github.io/<repo>/…
  // — we can read owner/repo straight from that URL, no channels.json needed.
  function guessFromPagesHost() {
    var m = /^([a-z0-9][a-z0-9-]*)\.github\.io$/i.exec(location.hostname);
    if (!m) return {};
    var p = location.pathname.split("/").filter(Boolean);
    if (p.length === 0) return {};
    return { owner: m[1], repo: decodeURIComponent(p[0]) };
  }

  async function loadConfig() {
    try {
      var r = await fetch(CONFIG_URL + "?cb=" + Date.now(), { cache: "no-store" });
      if (r.ok) cfg = await r.json();
    } catch (e) { /* stays null → handled below */ }
    if (!cfg || typeof cfg !== "object") cfg = {};
    // Merge in values inferred from the current page URL (works when browsing
    // the file on github.com itself), so channels.json can stay minimal.
    var guess = guessFromLocation();
    var pages = guessFromPagesHost();
    cfg.owner  = cfg.owner  || guess.owner  || pages.owner;
    cfg.repo   = cfg.repo   || guess.repo   || pages.repo;
    cfg.branch = cfg.branch || guess.branch || "main";
    // The committed token field is only a legacy fallback; prefer the local one.
    if (getToken()) cfg.token = getToken();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { injectUI(); loadConfig(); });
  } else {
    injectUI();
    loadConfig();
  }
})();
