/* add-channel.js — powers the "+ Add channel" form on index.html.
 *
 * What it does (all in the browser, no server needed):
 *   1. Builds a brand-new channel page from template.html (your exact default code).
 *   2. Commits it to your GitHub repo via the GitHub Contents API as xyzchannel.html.
 *   3. Updates channels.json + index.html in the same repo so the new link appears.
 *   4. Once GitHub Pages rebuilds (~30–60 s), the card is live on your site.
 *
 * One-time setup (edit channels.json in this repo):
 *   "owner": "your-github-username",
 *   "repo":  "your-repo-name",
 *   "branch": "main",
 *   "token": "github personal access token (classic) with 'repo' scope"
 *   Create the token at: https://github.com/settings/tokens
 *
 * SECURITY NOTE: the token lives in channels.json inside this repo, so ANYONE who can
 * see the repo can commit to it. Use a dedicated bot account / fine-grained token that
 * can only touch this repo. Keep the repo's Pages publish source trusted.
 */
(function () {
  "use strict";

  var CONFIG_URL = "channels.json";
  var TEMPLATE_URL = "template.html";
  var INDEX_URL = "index.html";

  var btn, form, titleEl, urlEl, fileEl, statusEl;
  var cfg = null, tpl = null;

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
      "Authorization": "token " + cfg.token,
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

    if (!cfg || !cfg.owner || !cfg.repo || !cfg.token) {
      return show('Not configured yet. Edit channels.json in this repo: set "owner", "repo" and a "token".', "err");
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

  async function loadConfig() {
    try {
      var r = await fetch(CONFIG_URL + "?cb=" + Date.now(), { cache: "no-store" });
      if (r.ok) cfg = await r.json();
    } catch (e) { /* stays null → submit shows setup hint */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { injectUI(); loadConfig(); });
  } else {
    injectUI();
    loadConfig();
  }
})();
