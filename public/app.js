const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { me: null, ai: false, library: [], tagFilter: null, search: { params: null, cursor: null }, subunits: null };
const TOPIC_LABEL = { structure: "Structure", disease: "Disease", substrates: "Substrates" };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.endsWith("/login") && !path.endsWith("/join")) { showLogin(); throw new Error("Not signed in"); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- auth ----------
// DDUUI chrome (served by Gudmundr Gateway) is optional at runtime: if it fails
// to load, the app still works with its own markup.
const chrome = () => window.DDUUI || null;

function showOnly(id) {
  for (const v of ["login", "join", "app"]) $(`#${v}`).hidden = v !== id;
  if (id !== "app") chrome()?.setUser(null);
}
function showLogin() {
  showOnly("login");
  const err = new URLSearchParams(location.search).get("sso_error");
  $("#sso-error").textContent = err || "";
  if (err) history.replaceState(null, "", location.pathname + location.hash);
}

async function showJoin() {
  const j = await api("/api/join").catch(() => ({ pending: false }));
  if (!j.pending) return false;
  showOnly("join");
  $("#join-email").textContent = j.email;
  $("#join-form").elements.name.value = j.name || "";
  return true;
}
$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#join-error").textContent = "";
  try {
    await api("/api/join", { method: "POST", body: { name: f.get("name"), passcode: f.get("passcode") } });
    history.replaceState(null, "", "/#library");
    await boot();
  } catch (err) { $("#join-error").textContent = err.message; }
});

async function signOut() {
  const r = await api("/api/logout", { method: "POST" }).catch(() => ({}));
  // Gateway-session users also end the ecosystem session (single sign-out).
  if (state.idp === "gateway") { location.href = "/auth/logout"; return false; }
  showLogin();
  return false;
}
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { name: f.get("name"), passcode: f.get("passcode") } });
    await boot();
  } catch (err) { $("#login-error").textContent = err.message; }
});
if (chrome()) chrome().config.onSignOut = signOut;

// ---------- tabs ----------
function showTab(name) {
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".tab").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "subunits") loadSubunits();
  if (name === "library") renderLibrary();
  if (name === "scope") loadScope();
  if (name === "explore") loadExplore();
}
$$(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------- shared paper card ----------
function meta(p) {
  const authors = p.authors ? (p.authors.split(", ").length > 3 ? `${p.authors.split(", ")[0]} et al.` : p.authors.replace(/\.$/, "")) : "";
  return [authors, p.journal, p.year].filter(Boolean).map(esc).join(" · ");
}
function idLinks(p) {
  const out = [];
  if (p.pmid) out.push(`<a href="https://pubmed.ncbi.nlm.nih.gov/${esc(p.pmid)}/" target="_blank" rel="noopener">PMID ${esc(p.pmid)}</a>`);
  if (p.doi) out.push(`<a href="https://doi.org/${esc(p.doi)}" target="_blank" rel="noopener">DOI</a>`);
  if (p.pmcid) out.push(`<a href="https://europepmc.org/article/PMC/${esc(p.pmcid)}" target="_blank" rel="noopener">Full text (${esc(p.pmcid)})</a>`);
  if (!p.pmid && p.source === "PPR") out.push(`<a href="https://europepmc.org/article/PPR/${esc(p.ext_id)}" target="_blank" rel="noopener">Preprint</a>`);
  return out.join(" · ");
}
const topicChips = (topics = []) => topics.map((t) => `<span class="chip t-${t}">${TOPIC_LABEL[t] || esc(t)}</span>`).join("");

// ---------- search ----------
$("#search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  state.search.params = Object.fromEntries(new FormData(e.target));
  state.search.cursor = "*";
  $("#search-results").innerHTML = "";
  runSearch();
});
$("#search-more").addEventListener("click", runSearch);

async function runSearch() {
  const status = $("#search-status");
  status.textContent = "Searching Europe PMC (PubMed + preprints)…";
  $("#search-more").hidden = true;
  try {
    const qs = new URLSearchParams({ ...state.search.params, cursor: state.search.cursor });
    const data = await api(`/api/search?${qs}`);
    status.textContent = `${data.total.toLocaleString()} results`;
    $("#search-results").insertAdjacentHTML("beforeend", data.results.map(searchCard).join(""));
    state.search.cursor = data.nextCursor;
    $("#search-more").hidden = !data.nextCursor;
  } catch (err) { status.textContent = err.message; }
}

function searchCard(p) {
  return `<li class="paper" data-source="${esc(p.source)}" data-ext="${esc(p.ext_id)}">
    <h3 class="paper-title">${esc(p.title)}</h3>
    <div class="paper-meta">${meta(p)}${p.cited_by ? ` · cited by ${p.cited_by}` : ""}</div>
    ${p.abstract ? `<p class="paper-abstract">${esc(p.abstract)}</p>` : `<p class="paper-abstract">No abstract available.</p>`}
    <div class="paper-row">
      ${p.preprint ? `<span class="chip pre">Preprint</span>` : ""}
      <span class="small">${idLinks(p)}</span>
      <span class="spacer"></span>
      ${p.library_id
        ? `<button class="btn small" data-open="${p.library_id}">In library — open</button>`
        : `<button class="btn small primary" data-add>+ Add to library</button>`}
    </div>
  </li>`;
}

$("#search-results").addEventListener("click", async (e) => {
  const li = e.target.closest(".paper");
  if (!li) return;
  if (e.target.matches(".paper-abstract")) return e.target.classList.toggle("open");
  if (e.target.dataset.open) return openPaper(Number(e.target.dataset.open));
  if (e.target.hasAttribute("data-add")) {
    e.target.disabled = true; e.target.textContent = "Adding…";
    try {
      const { id } = await api("/api/papers", { method: "POST", body: { source: li.dataset.source, ext_id: li.dataset.ext } });
      e.target.outerHTML = `<button class="btn small" data-open="${id}">In library — open</button>`;
      toast("Added to the lab library");
      loadLibrary();
    } catch (err) { e.target.disabled = false; e.target.textContent = "+ Add to library"; toast(err.message); }
  }
});

// ---------- library ----------
async function loadLibrary() {
  state.library = await api("/api/papers");
  $("#lib-count").textContent = state.library.length || "";
  if (!$("#tab-library").hidden) renderLibrary();
}
["#lib-filter", "#lib-topic", "#lib-status", "#lib-sort"].forEach((s) => $(s).addEventListener("input", renderLibrary));

function renderLibrary() {
  const text = $("#lib-filter").value.toLowerCase().trim();
  const topic = $("#lib-topic").value, status = $("#lib-status").value, sort = $("#lib-sort").value;
  let list = state.library.filter((p) =>
    (!text || `${p.title} ${p.authors} ${p.abstract} ${p.tags.join(" ")} ${p.journal}`.toLowerCase().includes(text)) &&
    (!topic || p.topics.includes(topic)) &&
    (!status || (status === "read") === p.read) &&
    (!state.tagFilter || p.tags.includes(state.tagFilter)));
  if (sort === "year") list = [...list].sort((a, b) => (b.year || 0) - (a.year || 0));
  if (sort === "notes") list = [...list].sort((a, b) => b.note_count - a.note_count);

  const tags = [...new Set(state.library.flatMap((p) => p.tags))].sort();
  $("#lib-tags").innerHTML = tags.map((t) => `<button class="chip" data-tag="${esc(t)}" aria-pressed="${state.tagFilter === t}">#${esc(t)}</button>`).join("");

  $("#lib-list").innerHTML = list.length ? list.map((p) => `<li class="paper ${p.read ? "is-read" : ""}">
    <h3 class="paper-title"><button data-open="${p.id}">${esc(p.title)}</button></h3>
    <div class="paper-meta">${meta(p)}</div>
    <div class="paper-row">
      ${topicChips(p.topics)}
      ${p.tags.map((t) => `<span class="chip">#${esc(t)}</span>`).join("")}
      <span class="spacer"></span>
      <span class="small muted">${p.note_count ? `💬 ${p.note_count} · ` : ""}added by ${esc(p.added_by)}${p.readers.length ? ` · read by ${p.readers.length}` : ""}</span>
      <button class="btn small" data-read="${p.id}" aria-pressed="${p.read}">${p.read ? "✓ Read" : "Mark read"}</button>
    </div>
  </li>`).join("") : `<li class="muted">No papers match.</li>`;
}

$("#lib-tags").addEventListener("click", (e) => {
  const t = e.target.dataset.tag; if (!t) return;
  state.tagFilter = state.tagFilter === t ? null : t; renderLibrary();
});
$("#lib-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.open) return openPaper(Number(b.dataset.open));
  if (b.dataset.read) {
    const p = state.library.find((x) => x.id === Number(b.dataset.read));
    await api(`/api/papers/${p.id}/read`, { method: "POST", body: { read: !p.read } });
    await loadLibrary(); renderLibrary();
  }
});

// ---------- daily auto-scan status ----------
function scanText(last) {
  if (!last) return "Daily scan: first run pending — new CCT/TRiC papers are added automatically each day (tagged #auto; proposal-focused ones also #focus).";
  const when = new Date(last.at).toLocaleString();
  return `Daily scan: last run ${when} — ${last.added} new paper${last.added === 1 ? "" : "s"} added (${last.focus} #focus) from ${last.found} found, ${last.from} → ${last.to}.`;
}
function setScanStatus(text) {
  $("#scan-status").textContent = text;
  chrome()?.setStatus(text);
}
async function loadScan() {
  try { const r = await api("/api/scan"); setScanStatus(scanText(r.last)); } catch { /* ignore */ }
}
$("#scan-now").addEventListener("click", async (e) => {
  e.target.disabled = true;
  setScanStatus("Daily scan: searching Europe PMC for new CCT/TRiC papers…");
  try {
    const r = await api("/api/scan", { method: "POST" });
    setScanStatus(scanText(r.at ? r : r.last));
    await loadLibrary();
    toast(r.added ? `${r.added} new paper${r.added === 1 ? "" : "s"} added` : "No new papers");
  } catch (err) { setScanStatus(err.message); }
  e.target.disabled = false;
});

// ---------- paper drawer ----------
async function openPaper(id) {
  const drawer = $("#drawer");
  drawer.hidden = false;
  $("#drawer-body").innerHTML = `<p class="skeleton">Loading…</p>`;
  const p = await api(`/api/papers/${id}`);
  $("#drawer-body").innerHTML = `
    <h2 id="d-title">${esc(p.title)}</h2>
    <div class="paper-meta">${esc(p.authors || "")}</div>
    <div class="paper-meta">${[p.journal, p.year].filter(Boolean).map(esc).join(" · ")}</div>
    <div class="paper-row small mt-1">${idLinks(p)}</div>

    <div class="section">
      <h3>Topics &amp; tags</h3>
      <div class="tag-input" id="d-tags">
        ${Object.keys(TOPIC_LABEL).map((t) => `<button class="chip t-${t}" data-topic="${t}" aria-pressed="${p.topics.includes(t)}">${TOPIC_LABEL[t]}</button>`).join("")}
        ${p.tags.map((t) => `<span class="chip">#${esc(t)} <button class="x" data-untag="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join("")}
        <input id="d-newtag" placeholder="Add tag + Enter" maxlength="40" />
      </div>
    </div>

    <div class="section">
      <h3>Reading status</h3>
      <div class="paper-row">
        <button class="btn small" id="d-read">${p.read ? "✓ Read by you — mark unread" : "Mark as read"}</button>
        <span class="small muted">${p.readers.length ? `Read by ${p.readers.map(esc).join(", ")}` : "Nobody has marked this read yet"}</span>
      </div>
    </div>

    <div class="section">
      <h3>Abstract</h3>
      <div class="abstract-full">${esc(p.abstract || "No abstract available.")}</div>
    </div>

    <div class="section">
      <h3>AI summary</h3>
      <div id="d-ai">${p.ai_summary
        ? `<div class="ai-box">${md(p.ai_summary)}</div><p class="small muted">Generated by ${esc(aiName())} from the abstract only. <button class="btn link small" id="d-sum">Regenerate</button></p>`
        : state.ai ? `<button class="btn small" id="d-sum">Summarise abstract</button>` : `<p class="small muted">AI is turned off on this server.</p>`}</div>
    </div>

    <div class="section">
      <h3>Citations in the library</h3>
      <div id="d-cites"><p class="skeleton small">Loading…</p></div>
    </div>

    <div class="section">
      <h3>Lab notes (${p.notes.length})</h3>
      <div id="d-notes">${p.notes.map(noteHtml).join("") || `<p class="small muted">No notes yet — start the discussion.</p>`}</div>
      <form class="note-form" id="d-noteform">
        <textarea name="body" rows="3" required placeholder="Methods to try, questions for lab meeting, how it relates to your project…"></textarea>
        <div><button class="btn small primary">Add note</button></div>
      </form>
    </div>

    <div class="section">
      <button class="btn small" id="d-del">Remove from library</button>
      <span class="small muted">Added by ${esc(p.added_by)} on ${new Date(p.added_at).toLocaleDateString()}</span>
    </div>`;

  const refresh = () => { loadLibrary(); openPaper(id); };
  loadPaperCitations(id);
  $("#d-read").onclick = async () => { await api(`/api/papers/${id}/read`, { method: "POST", body: { read: !p.read } }); refresh(); };
  $("#d-tags").onclick = async (e) => {
    const t = e.target.dataset.topic, u = e.target.dataset.untag;
    if (t) {
      const topics = p.topics.includes(t) ? p.topics.filter((x) => x !== t) : [...p.topics, t];
      await api(`/api/papers/${id}`, { method: "PATCH", body: { topics } }); refresh();
    }
    if (u) { await api(`/api/papers/${id}`, { method: "PATCH", body: { tags: p.tags.filter((x) => x !== u) } }); refresh(); }
  };
  $("#d-newtag").onkeydown = async (e) => {
    if (e.key !== "Enter" || !e.target.value.trim()) return;
    await api(`/api/papers/${id}`, { method: "PATCH", body: { tags: [...p.tags, e.target.value] } }); refresh();
  };
  $("#d-noteform").onsubmit = async (e) => {
    e.preventDefault();
    await api(`/api/papers/${id}/notes`, { method: "POST", body: { body: new FormData(e.target).get("body") } }); refresh();
  };
  $("#d-notes").onclick = async (e) => {
    const n = e.target.dataset.delnote; if (!n) return;
    try { await api(`/api/notes/${n}`, { method: "DELETE" }); refresh(); } catch (err) { toast(err.message); }
  };
  const sum = $("#d-sum");
  if (sum) sum.onclick = async () => {
    $("#d-ai").innerHTML = `<p class="skeleton">Summarising…</p>`;
    try { await api(`/api/papers/${id}/summary`, { method: "POST" }); refresh(); }
    catch (err) { $("#d-ai").innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  };
  $("#d-del").onclick = async () => {
    if (!confirm("Remove this paper and its notes from the lab library for everyone?")) return;
    await api(`/api/papers/${id}`, { method: "DELETE" }); closeDrawer(); loadLibrary(); toast("Removed");
  };
}
const noteHtml = (n) => `<div class="note">
  <div class="note-head"><strong>${esc(n.author)}</strong><span>${new Date(n.created_at).toLocaleString()}</span>
  ${n.author === state.me ? `<button class="btn link small" data-delnote="${n.id}">Delete</button>` : ""}</div>
  <div class="note-body">${esc(n.body)}</div></div>`;

function closeDrawer() { $("#drawer").hidden = true; }
$("#drawer-close").onclick = closeDrawer;
$("#drawer").addEventListener("click", (e) => { if (e.target.id === "drawer") closeDrawer(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// ---------- subunits ----------
async function loadSubunits() {
  if (state.subunits) return;
  state.subunits = await api("/api/subunits");
  const pmidToId = Object.fromEntries(state.library.filter((p) => p.pmid).map((p) => [p.pmid, p.id]));
  $("#ring").innerHTML = state.subunits.subunits.map((s) =>
    `<button class="su" data-su="${s.id}" aria-pressed="false"><b>${s.id}</b><span>${esc(s.greek)} · ${esc(s.gene)}</span></button>`).join("");
  $("#clients").innerHTML = state.subunits.clients.map((c) => `<li>${esc(c.name)} ${c.pmids.map((m) =>
    pmidToId[m] ? `<button class="cite" data-open="${pmidToId[m]}">PMID:${m}</button>` : `<a class="small" href="https://pubmed.ncbi.nlm.nih.gov/${m}/" target="_blank" rel="noopener">PMID:${m}</a>`).join(" ")}</li>`).join("");
}
$("#ring").addEventListener("click", async (e) => {
  const b = e.target.closest(".su"); if (!b) return;
  $$(".su").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  const panel = $("#subunit-detail");
  panel.innerHTML = `<p class="skeleton">Loading ${b.dataset.su} from UniProt…</p>`;
  const s = await api(`/api/subunits/${b.dataset.su}`);
  const u = s.details;
  panel.innerHTML = `
    <h2>${esc(s.id)} <span class="muted">(CCT${esc(s.greek)})</span></h2>
    <div class="muted">${esc(s.name)}</div>
    <dl class="kv">
      <dt>Gene</dt><dd>${esc(s.gene)}</dd>
      <dt>UniProt</dt><dd><a href="https://www.uniprot.org/uniprotkb/${s.uniprot}" target="_blank" rel="noopener">${s.uniprot}</a></dd>
      ${u ? `<dt>Length</dt><dd>${u.length} aa</dd>` : ""}
      <dt>Aliases</dt><dd>${s.aliases.map(esc).join(", ")}</dd>
    </dl>
    ${u?.function ? `<div class="section"><h3>Function (UniProt)</h3><p class="small">${esc(u.function)}</p></div>` : ""}
    ${s.uniprotError ? `<p class="error">UniProt unavailable: ${esc(s.uniprotError)}</p>` : ""}
    ${u ? `<div class="section"><h3>Structures in the PDB (${u.pdb.length})</h3>
      <div class="scroll"><table class="pdb-table"><thead><tr><th>PDB</th><th>Method</th><th>Resolution</th><th>Chains</th></tr></thead><tbody>
      ${u.pdb.map((x) => `<tr><td><a href="https://www.rcsb.org/structure/${esc(x.id)}" target="_blank" rel="noopener">${esc(x.id)}</a></td><td>${esc(x.method || "")}</td><td>${esc(x.resolution || "")}</td><td>${esc(x.chains || "")}</td></tr>`).join("")}
      </tbody></table></div></div>` : ""}
    <div class="section"><h3>Library papers mentioning ${esc(s.id)} (${s.papers.length})</h3>
      ${s.papers.length ? `<ul class="clients">${s.papers.map((p) => `<li><button class="btn link small flush" data-open="${p.id}">${esc(p.title)}</button> <span class="small muted">${esc(p.journal || "")} ${p.year || ""}</span></li>`).join("")}</ul>`
        : `<p class="small muted">None yet. <button class="btn link small" data-searchsu="${esc(s.id)}">Search the literature for ${esc(s.id)} →</button></p>`}
    </div>`;
});
document.addEventListener("click", (e) => {
  const o = e.target.closest("[data-open]");
  if (o && (o.closest("#tab-subunits") || o.closest("#ask-out"))) openPaper(Number(o.dataset.open));
  const su = e.target.closest("[data-searchsu]");
  if (su) { const f = $("#search-form"); f.subunit.value = su.dataset.searchsu; showTab("search"); f.requestSubmit(); }
});

// ---------- scope ----------
const KIND_LABEL = { proposal: "Proposals", inquiry: "Areas of inquiry", concept: "Concepts", method: "Methods", note: "Lab notes" };
state.scope = [];

async function loadScope() {
  const r = await api("/api/scope");
  state.scope = r.items;
  renderScope();
}
["#scope-filter", "#scope-kind"].forEach((sel) => $(sel).addEventListener("input", renderScope));

function renderScope() {
  const text = $("#scope-filter").value.toLowerCase().trim(), kind = $("#scope-kind").value;
  const items = state.scope.filter((it) => (!kind || it.kind === kind) &&
    (!text || `${it.title} ${it.body} ${it.keywords.join(" ")}`.toLowerCase().includes(text)));
  if (!items.length) { $("#scope-list").innerHTML = `<p class="muted">Nothing here yet. Use “+ Add to scope”.</p>`; return; }
  $("#scope-list").innerHTML = Object.keys(KIND_LABEL).map((k) => {
    const group = items.filter((it) => it.kind === k);
    if (!group.length) return "";
    return `<div class="scope-group"><h3>${KIND_LABEL[k]} (${group.length})</h3>${group.map((it) => `
      <article class="scope-card ${it.active ? "" : "off"}">
        <div class="paper-row">
          <h4>${esc(it.title)}</h4>
          ${it.active ? "" : `<span class="chip">paused</span>`}
          <span class="spacer"></span>
          ${it.papers ? `<button class="btn link small" data-scopetag="scope-${esc(it.slug)}">${it.papers} matching paper${it.papers === 1 ? "" : "s"} →</button>` : `<span class="small muted">no matching papers yet</span>`}
          <button class="btn small" data-scopeedit="${it.id}">Edit</button>
        </div>
        ${it.keywords.length ? `<div class="paper-row">${it.keywords.map((k) => `<span class="chip">${esc(k)}</span>`).join("")}
          <span class="small muted">${it.context === "any" ? "· any paper" : "· with CCT/TRiC"}</span></div>` : ""}
        ${it.body ? `<p class="scope-body">${esc(it.body)}</p>` : ""}
        <div class="small muted">${it.link ? `<a href="${esc(it.link)}" target="_blank" rel="noopener">Open link</a> · ` : ""}added by ${esc(it.author)} · updated ${new Date(it.updated_at).toLocaleDateString()}</div>
      </article>`).join("")}</div>`;
  }).join("");
}

function openScopeForm(it) {
  const f = $("#scope-form");
  f.reset();
  f.id.value = it?.id || "";
  f.kind.value = it?.kind || "inquiry";
  f.title.value = it?.title || "";
  f.keywords.value = (it?.keywords || []).join(", ");
  f.context.value = it?.context || "cct";
  f.link.value = it?.link || "";
  f.body.value = it?.body || "";
  f.active.checked = it ? it.active : true;
  $("#scope-delete").hidden = !it;
  $("#scope-error").textContent = "";
  f.hidden = false;
  f.title.focus();
  f.scrollIntoView({ behavior: "smooth", block: "start" });
}
$("#scope-add").addEventListener("click", () => openScopeForm(null));
$("#scope-cancel").addEventListener("click", () => ($("#scope-form").hidden = true));
$("#scope-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = { kind: f.kind.value, title: f.title.value, keywords: f.keywords.value, context: f.context.value,
    link: f.link.value, body: f.body.value, active: f.active.checked };
  try {
    const r = f.id.value
      ? await api(`/api/scope/${f.id.value}`, { method: "PUT", body })
      : await api("/api/scope", { method: "POST", body });
    f.hidden = true;
    toast(`Saved — ${r.papers} library paper${r.papers === 1 ? "" : "s"} match. The next daily scan will search these terms.`);
    await Promise.all([loadScope(), loadLibrary()]);
  } catch (err) { $("#scope-error").textContent = err.message; }
});
$("#scope-delete").addEventListener("click", async () => {
  const id = $("#scope-form").id.value;
  if (!id || !confirm("Delete this scope item for everyone? Papers keep their other tags.")) return;
  await api(`/api/scope/${id}`, { method: "DELETE" });
  $("#scope-form").hidden = true;
  await Promise.all([loadScope(), loadLibrary()]);
});
$("#scope-list").addEventListener("click", (e) => {
  const ed = e.target.closest("[data-scopeedit]");
  if (ed) return openScopeForm(state.scope.find((x) => x.id === Number(ed.dataset.scopeedit)));
  const tg = e.target.closest("[data-scopetag]");
  if (tg) { state.tagFilter = tg.dataset.scopetag; showTab("library"); return; }
  if (e.target.matches(".scope-body")) e.target.classList.toggle("open");
});

// ---------- AI status (Granite runs inside the app) ----------
function aiName() {
  const a = state.aiStatus || {};
  if (a.provider === "granite") return `IBM Granite (${(a.model || "").split("/").pop().replace(/-ONNX.*$/, "")})`;
  if (a.provider === "claude") return "Claude";
  return "the AI";
}
function aiStatusText(a) {
  if (!a || a.provider === "off") return "AI is turned off.";
  if (a.provider === "claude") return a.status === "ready" ? "AI: Claude (Anthropic API)." : `AI: Claude — ${a.error}`;
  const name = aiName();
  switch (a.status) {
    case "ready": return `AI: ${name}, running inside the app — free, private, no API key. Answers take ~20–60 s on CPU.`;
    case "downloading": return `AI: ${name} is downloading (first start only) — ${a.detail || ""}`;
    case "loading": return `AI: ${name} is loading into memory…`;
    case "error": return `AI: ${name} failed to load — ${a.error}`;
    default: return `AI: ${name} will load on first use.`;
  }
}
async function pollAi() {
  try { state.aiStatus = await api("/api/ai/status"); } catch { return; }
  const el = $("#ai-status");
  if (el) el.textContent = aiStatusText(state.aiStatus);
  if (["downloading", "loading", "idle"].includes(state.aiStatus.status)) setTimeout(pollAi, 3000);
}

// ---------- ask ----------
function md(text) {
  // Minimal, safe markdown: escape, then bold, bullets, paragraphs, and citation buttons.
  const byLabel = Object.fromEntries(state.library.map((p) => [p.pmid ? `PMID:${p.pmid}` : `${p.source}:${p.ext_id}`, p.id]));
  let h = esc(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/\[((?:PMID|PPR|MED):[A-Za-z0-9]+)\]/g, (m, l) => byLabel[l] ? `<button class="cite" data-open="${byLabel[l]}">${l}</button>` : `<span class="cite">${l}</span>`);
  return h.split(/\n{2,}/).map((block) => {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${l.replace(/^\s*[-*•]\s+/, "")}</li>`).join("")}</ul>`;
    return `<p>${block.replace(/\n/g, "<br>")}</p>`;
  }).join("");
}

$("#ask-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#ask-out");
  if (!state.ai) { out.innerHTML = `<p class="error">AI is turned off on this server.</p>`; return; }
  const question = new FormData(e.target).get("question");
  const btn = e.target.querySelector("button"); btn.disabled = true;
  out.innerHTML = `<p class="skeleton">Reading the library with ${esc(aiName())}… (on CPU this can take up to a minute)</p>`;
  try {
    const r = await api("/api/ask", { method: "POST", body: { question } });
    out.innerHTML = `<div class="answer"><div class="answer-body">${md(r.answer)}</div>
      ${r.sources.length ? `<div class="sources">Answered from ${r.sources.length} library abstract${r.sources.length > 1 ? "s" : ""}. Click a citation to open the paper. Generated by ${esc(aiName())} — verify against the full text.</div>` : ""}</div>`;
  } catch (err) { out.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  btn.disabled = false;
});

// ---------- explore: hypotheses + citation graph ----------
const citeLink = (n) => `<li><button class="btn link small" data-open="${n.id}">${esc(n.title)}</button> <span class="muted">${esc(n.year || "")}</span></li>`;

async function loadPaperCitations(id) {
  const el = $("#d-cites");
  if (!el) return;
  try {
    const c = await api(`/api/papers/${id}/citations`);
    const lists = (c.cites.length ? `<p class="small">Cites ${c.cites.length} library paper${c.cites.length > 1 ? "s" : ""}:</p><ul>${c.cites.map(citeLink).join("")}</ul>` : "")
      + (c.cited_by.length ? `<p class="small">Cited by ${c.cited_by.length} library paper${c.cited_by.length > 1 ? "s" : ""}:</p><ul>${c.cited_by.map(citeLink).join("")}</ul>` : "");
    el.innerHTML = c.fetched_at
      ? `${lists || `<p class="small muted">No citation links to other library papers.</p>`}
         <p class="small muted">Europe PMC lists ${c.totals.refs} references and ${c.totals.cited_by} citing papers. <button class="btn link small" id="d-cfetch">Refresh</button></p>`
      : `<button class="btn small" id="d-cfetch">Fetch citations from Europe PMC</button>`;
    const b = $("#d-cfetch");
    if (b) b.onclick = async () => {
      el.innerHTML = `<p class="skeleton small">Fetching…</p>`;
      try { await api(`/api/papers/${id}/citations`, { method: "POST" }); loadPaperCitations(id); }
      catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
    };
  } catch (err) { el.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}
$("#drawer-body").addEventListener("click", (e) => {
  const o = e.target.closest("#d-cites [data-open]");
  if (o) openPaper(Number(o.dataset.open));
});

function hypHtml(h) {
  return `<div class="answer hyp" data-hyp="${h.id}">
    <p class="small"><strong>${esc(h.author)}</strong> · ${new Date(h.created_at).toLocaleDateString()}
      ${h.author === state.me ? `<button class="btn link small" data-delhyp="${h.id}">Delete</button>` : ""}</p>
    <p class="hyp-statement">${esc(h.statement)}</p>
    <div class="answer-body">${md(h.analysis)}</div>
    ${h.searches?.length ? `<div class="paper-row small">Run a search: ${h.searches.map((s) => `<button class="chip" data-runsearch="${esc(s)}">${esc(s)}</button>`).join(" ")}</div>` : ""}
    <div class="sources">From ${h.sources.length} library abstract${h.sources.length === 1 ? "" : "s"}${h.model ? ` · ${esc(String(h.model).split("/").pop())}` : ""}. Verify against the full text.</div>
  </div>`;
}

async function loadHypotheses() {
  try {
    const list = await api("/api/hypotheses");
    $("#hyp-list").innerHTML = list.length ? list.map(hypHtml).join("") : `<p class="small muted">None yet.</p>`;
  } catch (err) { $("#hyp-list").innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}

$("#hyp-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#hyp-out");
  if (!state.ai) { out.innerHTML = `<p class="error">AI is turned off on this server.</p>`; return; }
  const statement = new FormData(e.target).get("statement");
  const btn = e.target.querySelector("button"); btn.disabled = true;
  out.innerHTML = `<p class="skeleton">Weighing the hypothesis with ${esc(aiName())}… (on CPU this can take up to a minute)</p>`;
  try {
    const h = await api("/api/hypotheses", { method: "POST", body: { statement } });
    out.innerHTML = hypHtml(h); e.target.reset(); loadHypotheses();
  } catch (err) { out.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  btn.disabled = false;
});

$("#tab-explore").addEventListener("click", async (e) => {
  const o = e.target.closest("[data-open]");
  if (o) return openPaper(Number(o.dataset.open));
  const rs = e.target.closest("[data-runsearch]");
  if (rs) {
    const f = $("#search-form");
    f.elements.text.value = rs.dataset.runsearch;
    showTab("search"); f.requestSubmit();
    return;
  }
  const d = e.target.closest("[data-delhyp]");
  if (d && confirm("Delete this hypothesis for everyone?")) {
    try { await api(`/api/hypotheses/${d.dataset.delhyp}`, { method: "DELETE" }); $("#hyp-out").innerHTML = ""; loadHypotheses(); }
    catch (err) { toast(err.message); }
  }
});

// Small force-directed layout in SVG: nodes are library papers, arrows point
// from the citing paper to the cited one. Isolated papers are left out.
function drawGraph(g) {
  const box = $("#graph");
  const linked = new Set(g.edges.flatMap((e) => [e.from, e.to]));
  const nodes = g.nodes.filter((n) => linked.has(n.id)).map((n, i, a) => ({ ...n, x: Math.cos((2 * Math.PI * i) / a.length), y: Math.sin((2 * Math.PI * i) / a.length) }));
  if (!nodes.length) { box.innerHTML = `<p class="small muted">No citation links between library papers yet. Fetch citations first.</p>`; return; }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = g.edges.map((e) => [byId.get(e.from), byId.get(e.to)]).filter(([a, b]) => a && b);
  for (let it = 0; it < 300; it++) {
    const k = 0.9 / Math.sqrt(nodes.length), t = 0.08 * (1 - it / 300);
    for (const a of nodes) { a.dx = 0; a.dy = 0; }
    for (const a of nodes) for (const b of nodes) {
      if (a === b) continue;
      const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 0.01;
      a.dx += (dx / d) * (k * k) / d; a.dy += (dy / d) * (k * k) / d;
    }
    for (const [a, b] of edges) {
      const dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy) || 0.01, f = (d * d) / k;
      a.dx -= (dx / d) * f; a.dy -= (dy / d) * f; b.dx += (dx / d) * f; b.dy += (dy / d) * f;
    }
    for (const a of nodes) {
      const d = Math.hypot(a.dx, a.dy) || 1;
      a.x += (a.dx / d) * Math.min(d, t) - a.x * 0.01; a.y += (a.dy / d) * Math.min(d, t) - a.y * 0.01;
    }
  }
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const W = 640, H = 420, P = 24;
  const sx = (x) => P + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * P), sy = (y) => P + ((y - y0) / (y1 - y0 || 1)) * (H - 2 * P);
  const topic = (n) => n.topics[0] ? `g-${n.topics[0]}` : "";
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
    <defs><marker id="arr" viewBox="0 0 10 10" refX="16" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="g-arrow"/></marker></defs>
    ${edges.map(([a, b]) => `<line class="g-edge" x1="${sx(a.x)}" y1="${sy(a.y)}" x2="${sx(b.x)}" y2="${sy(b.y)}" marker-end="url(#arr)"/>`).join("")}
    ${nodes.map((n) => `<g class="g-node ${topic(n)}" data-open="${n.id}" tabindex="0" role="button" aria-label="${esc(n.title)}">
      <circle cx="${sx(n.x)}" cy="${sy(n.y)}" r="${5 + Math.min(n.degree, 8)}"/><title>${esc(n.title)} (${esc(n.year || "?")}) · ${n.degree} link${n.degree === 1 ? "" : "s"}</title></g>`).join("")}
  </svg>`;
}

const suggestionHtml = (r) => `<li><a href="${r.source === "MED" ? `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(r.ext_id)}/` : `https://europepmc.org/article/${encodeURIComponent(r.source)}/${encodeURIComponent(r.ext_id)}`}" target="_blank" rel="noopener">${esc(r.title || `${r.source}:${r.ext_id}`)}</a>
  <span class="muted">${esc(r.year || "")} · ${r.shared} library papers</span>
  <button class="btn link small" data-addref="${esc(r.source)}:${esc(r.ext_id)}">Add</button></li>`;

async function loadGraph() {
  try {
    const g = await api("/api/graph");
    $("#graph-pending").textContent = g.pending ? `${g.pending} of ${g.total} papers have no citation data yet.` : `Citation data fetched for all ${g.total} papers.`;
    $("#graph-refresh").hidden = !g.pending;
    drawGraph(g);
    $("#graph-cited").innerHTML = g.suggestions.cited.map(suggestionHtml).join("") || `<li class="muted">Nothing shared by two or more library papers yet.</li>`;
    $("#graph-citing").innerHTML = g.suggestions.citing.map(suggestionHtml).join("") || `<li class="muted">Nothing shared by two or more library papers yet.</li>`;
  } catch (err) { $("#graph").innerHTML = `<p class="error">${esc(err.message)}</p>`; }
}

$("#graph-refresh").addEventListener("click", async (e) => {
  e.target.disabled = true;
  $("#graph-pending").textContent = "Fetching reference lists from Europe PMC…";
  try {
    const r = await api("/api/graph/refresh", { method: "POST", body: { limit: 20 } });
    toast(`Fetched ${r.fetched} papers${r.failed.length ? `, ${r.failed.length} failed` : ""}`);
  } catch (err) { toast(err.message); }
  e.target.disabled = false;
  loadGraph();
});

$("#tab-explore").addEventListener("click", async (e) => {
  const a = e.target.closest("[data-addref]");
  if (!a) return;
  const [source, ext_id] = a.dataset.addref.split(":");
  if (!/^(MED|PPR)$/.test(source)) { toast("Only PubMed records and preprints can be added."); return; }
  try { await api("/api/papers", { method: "POST", body: { source, ext_id } }); toast("Added to library"); loadLibrary(); loadGraph(); }
  catch (err) { toast(err.message); }
});

function loadExplore() { loadHypotheses(); loadGraph(); }

// ---------- boot ----------
async function boot() {
  try {
    var me = await api("/api/me");
    state.me = me.name; state.ai = me.ai; state.aiStatus = me.aiStatus;
  } catch {
    if (location.hash === "#join" && (await showJoin())) return;
    return;
  }
  showOnly("app");
  state.idp = me.idp; state.email = me.email;
  chrome()?.setUser({ name: me.name, email: me.email, idp: me.idp });
  await loadLibrary();
  loadScan();
  pollAi();
  showTab(["search", "library", "subunits", "scope", "ask", "explore"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "library");
}
boot();
