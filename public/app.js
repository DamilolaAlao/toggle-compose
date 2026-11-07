let seq = 0;
let notice = "";

const ICONS = {
  repos: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="2.5" width="12" height="4" rx="1"></rect><rect x="2" y="9.5" width="12" height="4" rx="1"></rect></svg>`,
  storage: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><ellipse cx="8" cy="4" rx="5.5" ry="2"></ellipse><path d="M2.5 4v8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2V4"></path><path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"></path></svg>`,
  tag: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8.5 2H14v5.5L7 14.5 1.5 9z"></path><circle cx="11" cy="5" r="1.1"></circle></svg>`,
  disk: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.2"></circle><circle cx="8" cy="8" r="1.5"></circle></svg>`,
};

const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="2" width="30" height="12" rx="2.5" fill="#3b82f6"></rect><rect x="1" y="18" width="30" height="12" rx="2.5" fill="#22d3ee"></rect></svg>`;
const ICON_COLORS = ["#3b82f6", "#0891b2", "#7c3aed", "#059669", "#d97706", "#e11d48"];

boot();

function boot() {
  document.addEventListener("click", onClick);
  document.addEventListener("input", onCatalog);
  document.addEventListener("change", onCatalog);
  window.addEventListener("popstate", () => render());
  render();
}

async function render() {
  const token = ++seq;
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  document.title = titleFor(path);
  let body;
  try {
    body = await view(path, params);
  } catch (error) {
    body = `<p class="error">${esc(error.message)}</p>`;
  }
  if (token !== seq) return;
  document.querySelector("#app").innerHTML = frame(body, path);
}

function titleFor(path) {
  if (path === "/repo") return "Repository · Toggle Compose";
  if (path === "/image") return "Image · Toggle Compose";
  if (path === "/storage") return "Storage · Toggle Compose";
  return "Repositories · Toggle Compose";
}

async function view(path, params) {
  if (path === "/") return homeView();
  if (path === "/repo") return repositoryView(params.get("name") || "");
  if (path === "/image") return imageView(params.get("name") || "", params.get("ref") || "");
  if (path === "/storage") return storageView();
  return `<h1>Page not found</h1><p class="lede">That address does not match anything in the console.</p><p><a class="crumb" href="/">Back to repositories</a></p>`;
}

async function homeView() {
  const [overview, storage] = await Promise.all([api("/api/overview"), api("/api/storage")]);
  const repos = [...(overview.repositories || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const tags = repos.reduce((sum, repo) => sum + (repo.tagCount || 0), 0);
  const list = repos.length
    ? `<ol class="hub-list">${repos.map((repo) => hubRow(repo)).join("")}</ol>`
    : `<div class="hub-list"><p class="empty-row">Nothing here yet. Push an image to this host and it will appear in the catalog.</p></div>`;
  return `${takeNotice()}
    <div class="page-head">
      <div>
        <h1>Repositories</h1>
        <p class="lede">Every image on this registry. Search by name, or open a repository to browse its tags.</p>
      </div>
    </div>
    <section class="stats">
      ${stat("blue", "Repositories", overview.repositories?.length || 0, `${tags} tag${tags === 1 ? "" : "s"}`)}
      ${stat("cyan", "Blobs", overview.blobs || 0, "Content-addressed layers")}
      ${stat("violet", "Stored", formatBytes(overview.bytes || 0), storage.backend === "r2" ? "Cloudflare R2" : "In-memory")}
      ${stat("amber", "Host", location.host, "Open registry")}
    </section>
    <div class="home">
      <section>
        <div class="catalog-head">
          <h2 id="result-count">${repos.length} repositor${repos.length === 1 ? "y" : "ies"}</h2>
          <div class="catalog-tools">
            <input id="filter" type="search" placeholder="Search repositories" aria-label="Search repositories">
            <select id="sort" aria-label="Sort repositories">
              <option value="updated">Recently updated</option>
              <option value="name">Name</option>
            </select>
          </div>
        </div>
        ${list}
      </section>
      <aside class="stack">
        <section class="card">
          <h2>Activity</h2>
          ${activityList(storage.activity || [])}
        </section>
        <section class="card">
          <h2>Push an image</h2>
          <p class="muted">Tag an image with this host and push. No login required.</p>
          ${copyField(`docker push ${location.host}/library/app:latest`)}
        </section>
      </aside>
    </div>`;
}

function hubRow(repo) {
  const parts = splitName(repo.name);
  const pull = `docker pull ${location.host}/${repo.name}`;
  return `<li class="hub-row" data-repo="${esc(repo.name.toLowerCase())}" data-updated="${esc(repo.updatedAt || "")}">
    <a class="hub-link" href="/repo?name=${encodeURIComponent(repo.name)}">
      <span class="hub-icon" style="background:${iconColor(parts.repo)}">${esc(initials(parts.repo))}</span>
      <span>
        <span class="hub-name">${parts.namespace ? `<span class="ns">${esc(parts.namespace)}</span>` : ""}${esc(parts.repo)}</span>
        <span class="hub-meta">
          <span><b>${repo.tagCount}</b> tag${repo.tagCount === 1 ? "" : "s"}</span>
          ${repo.updatedAt ? `<span>Updated <b>${esc(formatAgo(repo.updatedAt))}</b></span>` : ""}
        </span>
      </span>
    </a>
    <button class="ghost small" type="button" data-action="copy" data-copy="${esc(pull)}">Pull</button>
  </li>`;
}

async function repositoryView(name) {
  let repo;
  try {
    repo = await api(`/api/repository?name=${encodeURIComponent(name)}`);
  } catch (error) {
    if (error.status === 404) return `<h1>Repository not found</h1><p class="lede">Nothing has been pushed to <span class="mono">${esc(name)}</span>, or it was deleted.</p><p><a class="crumb" href="/">Back to repositories</a></p>`;
    throw error;
  }
  const rows = repo.tags.map((tag) => {
    const kind = kindOf(tag.mediaType);
    const pull = `docker pull ${location.host}/${repo.name}:${tag.name}`;
    return `<tr>
      <td><a class="repo-link" href="/image?name=${encodeURIComponent(repo.name)}&ref=${encodeURIComponent(tag.name)}">${esc(tag.name)}</a></td>
      <td><span class="pill ${kind === "index" ? "index" : ""}">${esc(kind === "index" ? "multi-arch" : "image")}</span></td>
      <td class="digest" title="${esc(tag.digest)}">${esc(shortDigest(tag.digest))}</td>
      <td>${esc(formatBytes(tag.size || 0))}</td>
      <td>${esc(formatAgo(tag.updatedAt))}<div class="muted">${esc(formatWhen(tag.updatedAt))}</div></td>
      <td class="actions">
        <button class="ghost small" type="button" data-action="copy" data-copy="${esc(pull)}">Pull</button>
        <button class="ghost small" type="button" data-action="delete-image" data-label="Delete" data-name="${esc(repo.name)}" data-ref="${esc(tag.name)}">Delete</button>
      </td>
    </tr>`;
  }).join("");
  const latest = repo.tags.find((tag) => tag.name === "latest")?.name || repo.tags[0]?.name || "";
  const updated = repo.tags[0]?.updatedAt;
  return `${takeNotice()}<p class="crumbs"><a class="crumb" href="/">Repositories</a><span>/</span><span>${esc(repo.name)}</span></p>
    <div class="page-head">
      <div>
        <h1>${esc(repo.name)}</h1>
        <div class="chips">
          <span class="chip blue">${ICONS.tag}<b>${repo.tags.length}</b> tag${repo.tags.length === 1 ? "" : "s"}</span>
          ${updated ? `<span class="chip">${ICONS.disk}Updated <b>${esc(formatAgo(updated))}</b></span>` : ""}
        </div>
      </div>
      <button class="danger" type="button" data-action="delete-repo" data-label="Delete repository" data-name="${esc(repo.name)}">Delete repository</button>
    </div>
    ${latest ? copyField(`docker pull ${location.host}/${repo.name}:${latest}`) : `<p class="muted">No tags yet. Push one to this repository to get started.</p>`}
    <div class="table-wrap spaced"><table>
      <thead><tr><th>Tag</th><th>Type</th><th>Digest</th><th>Manifest</th><th>Pushed</th><th></th></tr></thead>
      <tbody>${rows || `<tr><td colspan="6">No tags.</td></tr>`}</tbody>
    </table></div>`;
}

async function imageView(name, ref) {
  let image;
  try {
    image = await api(`/api/image?name=${encodeURIComponent(name)}&ref=${encodeURIComponent(ref)}`);
  } catch (error) {
    if (error.status === 404) return `<h1>Image not found</h1><p class="lede"><span class="mono">${esc(ref)}</span> is not a tag or digest in <span class="mono">${esc(name)}</span>.</p><p><a class="crumb" href="/repo?name=${encodeURIComponent(name)}">Back to repository</a></p>`;
    throw error;
  }
  const layers = image.layers || [];
  const platforms = image.platforms || [];
  const compressed = layers.reduce((sum, layer) => sum + (Number(layer.size) || 0), 0);
  const pull = image.digest && ref.includes(":")
    ? `docker pull ${location.host}/${image.name}@${image.digest}`
    : `docker pull ${location.host}/${image.name}:${ref}`;
  const layerRows = layers.map((layer, index) => `<tr>
    <td class="digest" title="${esc(layer.digest)}">${index + 1} · ${esc(shortDigest(layer.digest))}<div class="muted">${esc(layer.mediaType || "")}</div></td>
    <td>${layer.size == null ? "—" : esc(formatBytes(layer.size))}</td>
    <td><div class="share"><div class="bar-track"><span class="bar ${widthClass(layer.size || 0, compressed)}"></span></div></div></td>
  </tr>`).join("");
  const platformRows = platforms.map((item) => `<tr>
    <td>${item.digest ? `<a class="repo-link" href="/image?name=${encodeURIComponent(image.name)}&ref=${encodeURIComponent(item.digest)}">${esc(platformText(item))}</a>` : esc(platformText(item))}</td>
    <td class="digest">${esc(shortDigest(item.digest))}</td>
    <td>${item.size == null ? "—" : esc(formatBytes(item.size))}</td>
  </tr>`).join("");
  return `${takeNotice()}<p class="crumbs"><a class="crumb" href="/">Repositories</a><span>/</span><a class="crumb" href="/repo?name=${encodeURIComponent(image.name)}">${esc(image.name)}</a><span>/</span><span class="mono">${esc(ref)}</span></p>
    <div class="page-head">
      <div>
        <h1>${esc(ref)}</h1>
        <p class="lede mono">${esc(image.mediaType || "")}</p>
        <div class="chips">
          <span class="pill ${image.kind === "index" ? "index" : ""}">${esc(image.kind === "index" ? "multi-arch" : "image")}</span>
          ${layers.length ? `<span class="chip"><b>${layers.length}</b> layers</span>` : ""}
        </div>
      </div>
      <button class="danger" type="button" data-action="delete-image" data-label="Delete" data-name="${esc(image.name)}" data-ref="${esc(ref)}" data-back="/repo?name=${encodeURIComponent(image.name)}">Delete</button>
    </div>
    ${copyField(pull)}
    <section class="facts">
      <div class="fact"><span>Digest</span><strong>${esc(shortDigest(image.digest))}</strong></div>
      <div class="fact"><span>Compressed</span><strong>${esc(formatBytes(compressed || image.size || 0))}</strong></div>
      <div class="fact"><span>${platforms.length > 1 ? "Platforms" : "Platform"}</span><strong>${esc(platforms.length > 1 ? String(platforms.length) : platformText(platforms[0]))}</strong></div>
      <div class="fact"><span>Created</span><strong>${esc(image.config?.created ? formatAgo(image.config.created) : "—")}</strong></div>
    </section>
    <p class="digest">${esc(image.digest || "")}</p>
    <div class="split">
      <section class="card"><h2>${image.kind === "index" ? "Platforms" : "Image config"}</h2>${image.kind === "index" ? platformTable(platformRows) : configBlock(image.config)}</section>
      <section class="card"><h2>Layers</h2>${layerRows ? `<div class="table-wrap"><table><thead><tr><th>Layer</th><th>Size</th><th></th></tr></thead><tbody>${layerRows}</tbody></table></div>` : `<p class="muted">${image.kind === "index" ? "This is a multi-arch index. Pick a platform above to see its layers." : "No layers on this manifest."}</p>`}</section>
    </div>`;
}

function platformTable(rows) {
  if (!rows) return `<p class="muted">No platforms in this index.</p>`;
  return `<div class="table-wrap"><table><thead><tr><th>Platform</th><th>Digest</th><th>Size</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function configBlock(config) {
  if (!config) return `<p class="muted">This manifest has no image config.</p>`;
  const rows = [
    ["CMD", (config.cmd || []).join(" ")],
    ["ENTRYPOINT", (config.entrypoint || []).join(" ")],
    ["USER", config.user || ""],
    ["WORKDIR", config.workingDir || ""],
    ["OS", [config.os, config.architecture, config.variant].filter(Boolean).join("/")],
  ].filter(([, value]) => value);
  const env = (config.env || []).length
    ? `<h3>ENV</h3>${config.env.map((item) => `<p class="mono">${esc(item)}</p>`).join("")}`
    : "";
  const labels = Object.entries(config.labels || {});
  const labelBlock = labels.length
    ? `<h3>LABEL</h3><dl class="kv">${labels.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`
    : "";
  const list = rows.length
    ? `<dl class="kv">${rows.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd class="mono">${esc(value)}</dd></div>`).join("")}</dl>`
    : `<p class="muted">This image sets no command, user, or working directory.</p>`;
  return `${list}${env}${labelBlock}`;
}

async function storageView() {
  const data = await api("/api/storage");
  const warning = data.backend === "memory"
    ? `<p class="warn">Running on the in-memory store. Everything here is lost when the process stops. Set the R2 variables to persist blobs in Cloudflare R2.</p>`
    : `<p class="lede">Blobs are stored in Cloudflare R2${data.bucket ? ` in the <span class="mono">${esc(data.bucket)}</span> bucket` : ""}.</p>`;
  return `${takeNotice()}
    <div class="page-head">
      <div><h1>Storage</h1>${warning}</div>
      <button type="button" data-action="gc">Prune now</button>
    </div>
    <section class="stats">
      ${stat("blue", "Stored", formatBytes(data.bytes || 0), data.backend === "r2" ? "Cloudflare R2" : "In-memory")}
      ${stat("cyan", "Blobs", data.blobs || 0, `${data.repositories || 0} repositories`)}
      ${stat("violet", "Uploads", data.uploads || 0, "In progress")}
      ${stat("amber", "Grace", graceLabel(data.graceMs), "Recent blobs are kept")}
    </section>
    <section class="card">
      <h2>${esc(data.backend === "r2" ? "Cloudflare R2" : "In-memory")}</h2>
      <dl class="kv">
        <div><dt>Bucket</dt><dd class="mono">${esc(data.bucket || "—")}</dd></div>
        <div><dt>Endpoint</dt><dd class="mono">${esc(data.endpoint || "—")}</dd></div>
      </dl>
      <h2>Activity</h2>
      ${activityList(data.activity || [])}
    </section>`;
}

function takeNotice() {
  const text = notice;
  notice = "";
  return text ? `<p class="notice">${esc(text)}</p>` : "";
}

function frame(body, path) {
  const section = path === "/storage" ? "storage" : "repos";
  const link = (href, id, label) => `<a href="${href}" ${section === id ? 'aria-current="page"' : ""}>${ICONS[id]}<span>${label}</span></a>`;
  return `<div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/">${MARK}<span><strong>Toggle</strong><small>Compose</small></span></a>
      <nav class="nav">
        <p class="nav-label">Browse</p>
        ${link("/", "repos", "Repositories")}
        ${link("/storage", "storage", "Storage")}
      </nav>
      <p class="side-foot"><strong>Open registry.</strong> No login. Anyone who can reach this port can push, pull, and delete.</p>
    </aside>
    <main>${body}</main>
  </div>`;
}

function onCatalog(event) {
  if (event.target.id !== "filter" && event.target.id !== "sort") return;
  const query = (document.querySelector("#filter")?.value || "").trim().toLowerCase();
  const sort = document.querySelector("#sort")?.value || "updated";
  const list = document.querySelector(".hub-list");
  if (!list) return;
  const rows = [...list.querySelectorAll(".hub-row")];
  rows.sort((a, b) => {
    if (sort === "name") return a.dataset.repo.localeCompare(b.dataset.repo);
    return (b.dataset.updated || "").localeCompare(a.dataset.updated || "");
  });
  let shown = 0;
  for (const row of rows) {
    const visible = !query || row.dataset.repo.includes(query);
    row.hidden = !visible;
    if (visible) shown += 1;
    list.appendChild(row);
  }
  const count = document.querySelector("#result-count");
  if (count) count.textContent = `${shown} repositor${shown === 1 ? "y" : "ies"}`;
}

async function onClick(event) {
  const button = event.target.closest("button");
  const link = event.target.closest("a[href]");
  if (link && !button && link.origin === location.origin && link.target !== "_blank") {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    if (`${link.pathname}${link.search}` !== `${location.pathname}${location.search}`) {
      history.pushState({}, "", link.href);
    }
    render();
    return;
  }
  if (!button) {
    disarm();
    return;
  }
  if (button.dataset.action === "copy") {
    event.preventDefault();
    await copyText(button.dataset.copy || "", button);
    return;
  }
  if (button.dataset.action === "gc") {
    await runGc(button);
    return;
  }
  const action = button.dataset.action;
  if (action !== "delete-repo" && action !== "delete-image") return;
  if (button.dataset.armed !== "1") {
    disarm(button);
    button.dataset.armed = "1";
    button.textContent = "Confirm";
    return;
  }
  button.disabled = true;
  try {
    if (action === "delete-repo") {
      await api(`/api/repository?name=${encodeURIComponent(button.dataset.name)}`, { method: "DELETE" });
      notice = `Deleted ${button.dataset.name}`;
      history.pushState({}, "", "/");
    } else {
      await api(`/api/image?name=${encodeURIComponent(button.dataset.name)}&ref=${encodeURIComponent(button.dataset.ref)}`, { method: "DELETE" });
      notice = `Deleted ${button.dataset.ref}`;
      history.pushState({}, "", button.dataset.back || `/repo?name=${encodeURIComponent(button.dataset.name)}`);
    }
    await render();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Failed";
    notice = error.message;
  }
}

function disarm(except) {
  for (const button of document.querySelectorAll("button[data-armed='1']")) {
    if (button === except) continue;
    button.dataset.armed = "";
    button.textContent = button.dataset.label || "Delete";
  }
}

async function runGc(button) {
  button.disabled = true;
  const previous = button.textContent;
  button.textContent = "Pruning…";
  try {
    const result = await api("/api/gc", { method: "POST" });
    notice = `Pruned ${result.deleted} blob${result.deleted === 1 ? "" : "s"}, reclaimed ${formatBytes(result.bytes || 0)}. Kept ${result.keptRecent} recent.`;
    await render();
  } catch (error) {
    button.disabled = false;
    button.textContent = previous;
    notice = error.message;
    await render();
  }
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  const previous = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    if (button.isConnected) button.textContent = previous;
  }, 1200);
}

function activityList(items) {
  if (!items.length) return `<p class="muted">No activity yet. Deletes and prunes will be listed here.</p>`;
  return `<ul class="activity">${items.slice(0, 8).map((item) => `<li><span>${esc(activityText(item))}</span><time>${esc(formatAgo(item.at))} · ${esc(formatWhen(item.at))}</time></li>`).join("")}</ul>`;
}

function activityText(item) {
  if (item.action === "prune") return `Pruned ${item.deleted || 0} blobs (${formatBytes(item.bytes || 0)})`;
  if (item.action === "delete" && item.target === "repository") return `Deleted repository ${item.name}`;
  if (item.action === "delete" && item.target === "blob") return `Deleted blob ${shortDigest(item.digest)}`;
  if (item.action === "delete") return `Deleted ${item.name || "image"}${item.ref ? `:${item.ref}` : ""}`;
  return item.action || "Activity";
}

function stat(tone, label, value, caption) {
  return `<article class="stat c-${tone}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(caption)}</small></article>`;
}

function copyField(command) {
  return `<div class="copy-field"><code>${esc(command)}</code><button class="ghost small" type="button" data-action="copy" data-copy="${esc(command)}">Copy</button></div>`;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { accept: "application/json", ...(options.headers || {}) },
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function splitName(name) {
  const slash = name.lastIndexOf("/");
  if (slash < 0) return { namespace: "", repo: name };
  return { namespace: `${name.slice(0, slash + 1)}`, repo: name.slice(slash + 1) };
}

function initials(name) {
  const clean = name.replace(/[^a-z0-9]/gi, "");
  return (clean.slice(0, 2) || name.slice(0, 2) || "?").toUpperCase();
}

function iconColor(name) {
  let hash = 0;
  for (const char of name) hash = (hash + char.charCodeAt(0)) % ICON_COLORS.length;
  return ICON_COLORS[hash];
}

function kindOf(mediaType) {
  if (!mediaType) return "image";
  if (mediaType.includes("index") || mediaType.includes("manifest.list")) return "index";
  return "image";
}

function platformText(platform) {
  if (!platform) return "—";
  const bits = [platform.os, platform.architecture, platform.variant].filter(Boolean);
  return bits.length ? bits.join("/") : "—";
}

function shortDigest(digest) {
  const hex = String(digest || "").split(":")[1] || "";
  return hex ? hex.slice(0, 12) : "—";
}

function widthClass(part, total) {
  if (!total) return "w1";
  const step = Math.max(1, Math.min(10, Math.round((Number(part) / total) * 10)));
  return `w${step}`;
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let next = size / 1024;
  let unit = 0;
  while (next >= 1024 && unit < units.length - 1) {
    next /= 1024;
    unit += 1;
  }
  return `${next >= 10 ? next.toFixed(0) : next.toFixed(1)} ${units[unit]}`;
}

function formatWhen(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatAgo(iso) {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const steps = [[60, "second", 1], [3600, "minute", 60], [86400, "hour", 3600], [2592000, "day", 86400], [31536000, "month", 2592000]];
  const step = steps.find(([limit]) => seconds < limit) || [0, "year", 31536000];
  const value = Math.round(seconds / step[2]);
  return `${value} ${step[1]}${value === 1 ? "" : "s"} ago`;
}

function graceLabel(ms) {
  const value = Number(ms) || 0;
  if (!value) return "none";
  if (value % 60000 === 0) {
    const minutes = value / 60000;
    return `${minutes} min`;
  }
  return `${value} ms`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}
