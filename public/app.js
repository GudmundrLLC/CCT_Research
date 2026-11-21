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
  if (res.status === 401 && !path.endsWith("/login")) { showLogin(); throw new Error("Not signed in"); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- auth ----------
function showLogin() { $("#app").hidden = true; $("#login").hidden = false; }
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { name: f.get("name"), passcode: f.get("passcode") } });
    await boot();
  } catch (err) { $("#login-error").textContent = err.message; }
});
$("#logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }); showLogin(); });

// ---------- tabs ----------
function showTab(name) {
  $$(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  $$(".tab").forEach((s) => (s.hidden = s.id !== `tab-${name}`));
  if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  if (name === "subunits") loadSubunits();
  if (name === "library") renderLibrary();
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
async function loadScan() {
  try { const r = await api("/api/scan"); $("#scan-status").textContent = scanText(r.last); } catch { /* ignore */ }
}
$("#scan-now").addEventListener("click", async (e) => {
  e.target.disabled = true;
  $("#scan-status").textContent = "Daily scan: searching Europe PMC for new CCT/TRiC papers…";
  try {
    const r = await api("/api/scan", { method: "POST" });
    $("#scan-status").textContent = scanText(r.at ? r : r.last);
    await loadLibrary();
    toast(r.added ? `${r.added} new paper${r.added === 1 ? "" : "s"} added` : "No new papers");
  } catch (err) { $("#scan-status").textContent = err.message; }
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
    <div class="paper-row small" style="margin-top:6px">${idLinks(p)}</div>

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
        ? `<div class="ai-box">${md(p.ai_summary)}</div><p class="small muted">Generated by Claude from the abstract only. <button class="btn link small" id="d-sum">Regenerate</button></p>`
        : state.ai ? `<button class="btn small" id="d-sum">Summarise abstract</button>` : `<p class="small muted">AI is not configured on this server.</p>`}</div>
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
      ${s.papers.length ? `<ul class="clients">${s.papers.map((p) => `<li><button class="btn link small" data-open="${p.id}" style="padding:0;text-align:left">${esc(p.title)}</button> <span class="small muted">${esc(p.journal || "")} ${p.year || ""}</span></li>`).join("")}</ul>`
        : `<p class="small muted">None yet. <button class="btn link small" data-searchsu="${esc(s.id)}">Search the literature for ${esc(s.id)} →</button></p>`}
    </div>`;
});
document.addEventListener("click", (e) => {
  const o = e.target.closest("[data-open]");
  if (o && (o.closest("#tab-subunits") || o.closest("#ask-out"))) openPaper(Number(o.dataset.open));
  const su = e.target.closest("[data-searchsu]");
  if (su) { const f = $("#search-form"); f.subunit.value = su.dataset.searchsu; showTab("search"); f.requestSubmit(); }
});

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
  if (!state.ai) { out.innerHTML = `<p class="error">AI is not configured on this server yet (ANTHROPIC_API_KEY).</p>`; return; }
  const question = new FormData(e.target).get("question");
  const btn = e.target.querySelector("button"); btn.disabled = true;
  out.innerHTML = `<p class="skeleton">Reading the library…</p>`;
  try {
    const r = await api("/api/ask", { method: "POST", body: { question } });
    out.innerHTML = `<div class="answer"><div class="answer-body">${md(r.answer)}</div>
      ${r.sources.length ? `<div class="sources">Answered from ${r.sources.length} library abstract${r.sources.length > 1 ? "s" : ""}. Click a citation to open the paper. Generated by Claude — verify against the full text.</div>` : ""}</div>`;
  } catch (err) { out.innerHTML = `<p class="error">${esc(err.message)}</p>`; }
  btn.disabled = false;
});

// ---------- boot ----------
async function boot() {
  try {
    const me = await api("/api/me");
    state.me = me.name; state.ai = me.ai;
  } catch { return; }
  $("#login").hidden = true; $("#app").hidden = false;
  $("#who").textContent = state.me;
  await loadLibrary();
  loadScan();
  showTab(["search", "library", "subunits", "ask"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "library");
}
boot();
