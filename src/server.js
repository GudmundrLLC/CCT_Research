import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, migrate } from "./db.js";
import { search, lookup, recent } from "./literature.js";
import { SUBUNITS, CLIENTS, uniprotDetails } from "./subunits.js";
import { aiEnabled, aiStatus, warmUp, maxPapers, summarize, answer, exploreHypothesis, describeError } from "./ai.js";
import { pickPapers, paperLabel } from "./rank.js";
import { fetchLinks, buildGraph } from "./citations.js";
import { suggestedSearches } from "./hypothesis.js";
import { SEED } from "./seed.js";
import { GATEWAY_URL, verifyGatewayToken, gatewayGrants, allowListed, loginUrl } from "./gateway.js";
import { KINDS, slugify, tidyKeywords, clauseFor, isCct, activeItems, scopeTags, retag, exportMarkdown, seedScope } from "./scope.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));
const wrapAsync = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- auth: Gudmundr Gateway SSO (primary) + lab passcode (enrollment / fallback) ----------
// Ecosystem plan 2026-11-22: identity comes from Gudmundr Gateway (one sign-in for
// every Gudmundr app). The shared lab passcode stays as (a) the one-time step that
// enrolls a Gateway account into this lab and (b) a fallback sign-in until every
// lab member has linked their Gateway account.
const PASSCODE = process.env.LAB_PASSCODE || "";
const SECRET = crypto.createHash("sha256").update(`cct-hub:${process.env.SESSION_SECRET || PASSCODE}`).digest();
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
const SECURE = process.env.NODE_ENV === "production" || Boolean(process.env.RAILWAY_ENVIRONMENT) ? "; Secure" : "";

function readCookie(req, name) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!raw) return null;
  const [val, mac] = raw.split(".");
  if (!val || !mac) return null;
  const expected = sign(`${name}:${val}`);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    // Sessions issued before 2026-11-22 were signed without the cookie-name prefix.
    if (name !== "sess") return null;
    const legacy = sign(val);
    if (mac.length !== legacy.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(legacy))) return null;
  }
  try {
    const obj = JSON.parse(Buffer.from(val, "base64url").toString());
    if (obj && obj.exp && obj.exp < Date.now()) return null;
    return obj;
  } catch { return null; }
}

function writeCookie(res, name, obj, maxAgeS) {
  const val = Buffer.from(JSON.stringify(obj)).toString("base64url");
  res.append("Set-Cookie", `${name}=${val}.${sign(`${name}:${val}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${SECURE}`);
}
const clearCookie = (res, name) => res.append("Set-Cookie", `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${SECURE}`);

const readSession = (req) => readCookie(req, "sess");
const setSession = (res, user) => writeCookie(res, "sess", user, 60 * 60 * 24 * 90);
const publicOrigin = (req) => (process.env.APP_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

app.post("/api/login", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 60);
  const pass = String(req.body?.passcode || "");
  if (!PASSCODE) return res.status(503).json({ error: "The lab passcode hasn't been set up yet (LAB_PASSCODE)." });
  const a = crypto.createHash("sha256").update(pass).digest();
  const b = crypto.createHash("sha256").update(PASSCODE).digest();
  if (!name) return res.status(400).json({ error: "Enter your name." });
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Wrong passcode." });
  setSession(res, { name, idp: "passcode" });
  res.json({ name });
});

app.post("/api/logout", (_req, res) => {
  clearCookie(res, "sess");
  clearCookie(res, "gw_pending");
  res.json({ ok: true, gatewayLogout: `${GATEWAY_URL}/auth/logout` });
});

// Gateway SSO
app.get("/auth/gateway/start", (req, res) => {
  const state = crypto.randomBytes(18).toString("base64url");
  writeCookie(res, "gw_state", { state, exp: Date.now() + 10 * 60 * 1000 }, 600);
  res.redirect(302, loginUrl(publicOrigin(req), state));
});

app.get("/auth/gateway/callback", wrapAsync(async (req, res) => {
  const fail = (why) => res.redirect(302, `/?sso_error=${encodeURIComponent(why)}`);
  const st = readCookie(req, "gw_state");
  clearCookie(res, "gw_state");
  const state = String(req.query.state || "");
  if (!st?.state || state.length !== st.state.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(st.state))) {
    return fail("Sign-in expired or was started elsewhere. Try again.");
  }
  let claims;
  try { claims = await verifyGatewayToken(String(req.query.token || "")); }
  catch (e) { console.warn(`gateway sso rejected: ${e.message}`); return fail("Gudmundr Gateway sign-in could not be verified."); }
  const email = String(claims.email || claims.sub || "").trim().toLowerCase();
  if (!email.includes("@")) return fail("Your Gudmundr account has no email address.");
  const { rows } = await q(`SELECT display_name FROM members WHERE email = $1`, [email]);
  let name = rows[0]?.display_name;
  if (!name && (allowListed(email) || (await gatewayGrants(claims.sub)))) {
    name = String(claims.name || email.split("@")[0]).slice(0, 60);
    await q(`INSERT INTO members (email, display_name, enrolled_by) VALUES ($1,$2,'gateway-grant') ON CONFLICT (email) DO NOTHING`, [email, name]);
  }
  if (!name) {
    // Verified identity, not yet a lab member: ask for the lab passcode once.
    writeCookie(res, "gw_pending", { email, name: String(claims.name || "").slice(0, 60), exp: Date.now() + 15 * 60 * 1000 }, 900);
    return res.redirect(302, "/#join");
  }
  await q(`UPDATE members SET last_login_at = now() WHERE email = $1`, [email]);
  setSession(res, { name, email, idp: "gateway" });
  res.redirect(302, "/");
}));

app.get("/auth/logout", (_req, res) => {
  clearCookie(res, "sess");
  res.redirect(302, `${GATEWAY_URL}/auth/logout`);
});

app.get("/api/join", (req, res) => {
  const p = readCookie(req, "gw_pending");
  res.json(p ? { pending: true, email: p.email, name: p.name } : { pending: false });
});

app.post("/api/join", wrapAsync(async (req, res) => {
  const p = readCookie(req, "gw_pending");
  if (!p?.email) return res.status(401).json({ error: "Sign in with Gudmundr first." });
  if (!PASSCODE) return res.status(503).json({ error: "The lab passcode hasn't been set up yet (LAB_PASSCODE)." });
  const a = crypto.createHash("sha256").update(String(req.body?.passcode || "")).digest();
  const b = crypto.createHash("sha256").update(PASSCODE).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Wrong passcode." });
  const name = String(req.body?.name || p.name || p.email.split("@")[0]).trim().slice(0, 60);
  if (!name) return res.status(400).json({ error: "Enter the name to show on your notes." });
  await q(
    `INSERT INTO members (email, display_name, enrolled_by) VALUES ($1,$2,'passcode')
     ON CONFLICT (email) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [p.email, name],
  );
  clearCookie(res, "gw_pending");
  setSession(res, { name, email: p.email, idp: "gateway" });
  res.json({ name });
}));

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Scope export for the scheduled research runs: authenticated by the X-Scope-Key header
// (SCOPE_FEED_KEY env var), not by the lab cookie. Disabled when SCOPE_FEED_KEY is unset.
app.get("/api/scope/export.md", async (req, res) => {
  const key = process.env.SCOPE_FEED_KEY || "";
  const got = String(req.headers["x-scope-key"] || "");
  const ok = key && got.length === key.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(key));
  if (!ok) return res.status(401).type("text/plain").send("Unauthorized");
  try { res.type("text/markdown").send(await exportMarkdown()); }
  catch (e) { res.status(500).type("text/plain").send(e.message); }
});

app.use("/api", (req, res, next) => {
  const s = readSession(req);
  if (!s?.name) return res.status(401).json({ error: "Not signed in." });
  req.user = s.name;
  req.session = s;
  next();
});

app.get("/api/me", (req, res) => res.json({
  name: req.user, email: req.session.email || null, idp: req.session.idp || "passcode",
  ai: aiEnabled(), aiStatus: aiStatus(), gateway: GATEWAY_URL,
}));
app.get("/api/ai/status", (_req, res) => res.json(aiStatus()));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Server error" });
});

// ---------- topic auto-tagging ----------
const TOPIC_RX = {
  structure: /cryo-?em|cryo-electron|crystal structure|structur|atp hydrolysis|conformation|prefoldin|phlp|mechanism|allosteric/i,
  disease: /cancer|tumou?r|carcinoma|neurodegener|huntingtin|polyglutamine|polyq|alzheimer|parkinson|\btau\b|prognos|biomarker|drug target|therapeutic/i,
  substrates: /substrate|client|actin|tubulin|interactome|proteomic|wd40|wd-40|β-propeller|beta-propeller|folding of/i,
};
const classify = (p) => Object.keys(TOPIC_RX).filter((t) => TOPIC_RX[t].test(`${p.title} ${p.abstract || ""}`));

async function insertPaper(rec, addedBy, tags = []) {
  const topics = classify(rec);
  const { rows } = await q(
    `INSERT INTO papers (source, ext_id, pmid, pmcid, doi, title, authors, journal, year, abstract, topics, tags, added_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (source, ext_id) DO NOTHING RETURNING id`,
    [rec.source, rec.ext_id, rec.pmid, rec.pmcid, rec.doi, rec.title, rec.authors, rec.journal, rec.year, rec.abstract, topics, tags, addedBy],
  );
  return rows[0]?.id ?? null;
}

// ---------- search ----------
app.get("/api/search", wrap(async (req, res) => {
  const out = await search(req.query);
  const ids = out.results.map((r) => `${r.source}:${r.ext_id}`);
  const { rows } = await q(`SELECT source || ':' || ext_id AS k, id FROM papers WHERE source || ':' || ext_id = ANY($1)`, [ids]);
  const saved = Object.fromEntries(rows.map((r) => [r.k, r.id]));
  out.results.forEach((r) => (r.library_id = saved[`${r.source}:${r.ext_id}`] ?? null));
  res.json(out);
}));

// ---------- library ----------
const PAPER_COLS = `p.id, p.source, p.ext_id, p.pmid, p.pmcid, p.doi, p.title, p.authors, p.journal, p.year, p.abstract,
  p.topics, p.tags, p.added_by, p.added_at, p.ai_summary,
  (SELECT count(*)::int FROM notes n WHERE n.paper_id = p.id) AS note_count,
  EXISTS (SELECT 1 FROM reads r WHERE r.paper_id = p.id AND r.reader = $1) AS read,
  (SELECT coalesce(array_agg(r.reader ORDER BY r.read_at), '{}') FROM reads r WHERE r.paper_id = p.id) AS readers`;

app.get("/api/papers", wrap(async (req, res) => {
  const { rows } = await q(`SELECT ${PAPER_COLS} FROM papers p ORDER BY p.added_at DESC, p.year DESC NULLS LAST`, [req.user]);
  res.json(rows);
}));

app.get("/api/papers/:id", wrap(async (req, res) => {
  const { rows } = await q(`SELECT ${PAPER_COLS} FROM papers p WHERE p.id = $2`, [req.user, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const notes = await q(`SELECT id, author, body, created_at FROM notes WHERE paper_id = $1 ORDER BY created_at`, [req.params.id]);
  res.json({ ...rows[0], notes: notes.rows });
}));

app.post("/api/papers", wrap(async (req, res) => {
  const { source, ext_id } = req.body || {};
  const existing = await q(`SELECT id FROM papers WHERE source=$1 AND ext_id=$2`, [String(source), String(ext_id)]);
  if (existing.rows[0]) return res.json({ id: existing.rows[0].id, existed: true });
  const rec = await lookup(String(source), String(ext_id));
  if (!rec) return res.status(404).json({ error: "Couldn't find that record in Europe PMC." });
  const id = await insertPaper(rec, req.user);
  if (id === null) {
    const { rows } = await q(`SELECT id FROM papers WHERE source=$1 AND ext_id=$2`, [rec.source, rec.ext_id]);
    return res.json({ id: rows[0].id, existed: true });
  }
  res.status(201).json({ id });
}));

app.patch("/api/papers/:id", wrap(async (req, res) => {
  const tidy = (a) => [...new Set((Array.isArray(a) ? a : []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
  if (req.body.tags) await q(`UPDATE papers SET tags = $1 WHERE id = $2`, [tidy(req.body.tags), req.params.id]);
  if (req.body.topics) await q(`UPDATE papers SET topics = $1 WHERE id = $2`, [tidy(req.body.topics).filter((t) => t in TOPIC_RX), req.params.id]);
  res.json({ ok: true });
}));

app.delete("/api/papers/:id", wrap(async (req, res) => {
  await q(`DELETE FROM papers WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

app.post("/api/papers/:id/read", wrap(async (req, res) => {
  if (req.body.read) await q(`INSERT INTO reads (paper_id, reader) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, req.user]);
  else await q(`DELETE FROM reads WHERE paper_id=$1 AND reader=$2`, [req.params.id, req.user]);
  res.json({ ok: true });
}));

app.post("/api/papers/:id/notes", wrap(async (req, res) => {
  const body = String(req.body?.body || "").trim().slice(0, 10000);
  if (!body) return res.status(400).json({ error: "Note is empty." });
  const { rows } = await q(`INSERT INTO notes (paper_id, author, body) VALUES ($1,$2,$3) RETURNING id, author, body, created_at`, [req.params.id, req.user, body]);
  res.status(201).json(rows[0]);
}));

app.delete("/api/notes/:id", wrap(async (req, res) => {
  const { rowCount } = await q(`DELETE FROM notes WHERE id=$1 AND author=$2`, [req.params.id, req.user]);
  if (!rowCount) return res.status(403).json({ error: "You can only delete your own notes." });
  res.json({ ok: true });
}));

// ---------- BibTeX export ----------
app.get("/api/export.bib", wrap(async (_req, res) => {
  const { rows } = await q(`SELECT * FROM papers ORDER BY year, title`);
  const esc = (s) => String(s || "").replace(/[{}]/g, "");
  const bib = rows.map((p) => {
    const first = (p.authors || "anon").split(",")[0].split(" ")[0].replace(/[^A-Za-z]/g, "") || "anon";
    const key = `${first}${p.year || ""}_${p.pmid || p.ext_id}`;
    const fields = [
      ["title", `{${esc(p.title)}}`], ["author", esc((p.authors || "").replace(/\.$/, "").split(", ").join(" and "))],
      ["journal", esc(p.journal)], ["year", p.year], ["doi", p.doi], ["pmid", p.pmid],
    ].filter(([, v]) => v);
    return `@article{${key},\n${fields.map(([k, v]) => `  ${k} = {${v}}`).join(",\n")}\n}`;
  }).join("\n\n");
  res.setHeader("Content-Type", "application/x-bibtex; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="cct-library.bib"');
  res.send(bib);
}));

// ---------- subunits ----------
app.get("/api/subunits", (_req, res) => res.json({ subunits: SUBUNITS, clients: CLIENTS }));

app.get("/api/subunits/:id", wrap(async (req, res) => {
  const s = SUBUNITS.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: "Unknown subunit" });
  let details = null, uniprotError = null;
  try { details = await uniprotDetails(s.uniprot); } catch (e) { uniprotError = e.message; }
  const rx = s.aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const { rows } = await q(
    `SELECT id, title, journal, year, pmid FROM papers WHERE (title || ' ' || coalesce(abstract,'')) ~* $1 ORDER BY year DESC NULLS LAST`,
    [`(^|[^A-Za-z0-9])(${rx})([^A-Za-z0-9]|$)`],
  );
  res.json({ ...s, details, uniprotError, papers: rows });
}));

// ---------- AI ----------

app.post("/api/papers/:id/summary", wrap(async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "AI is turned off (AI_PROVIDER)." });
  const { rows } = await q(`SELECT * FROM papers WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  try {
    const text = await summarize(rows[0]);
    await q(`UPDATE papers SET ai_summary = $1 WHERE id = $2`, [text, req.params.id]);
    res.json({ summary: text });
  } catch (e) { res.status(502).json({ error: describeError(e) }); }
}));

app.post("/api/ask", wrap(async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "AI is turned off (AI_PROVIDER)." });
  const question = String(req.body?.question || "").trim().slice(0, 2000);
  if (!question) return res.status(400).json({ error: "Ask a question." });
  const { rows } = await q(`SELECT id, source, ext_id, pmid, title, journal, year, abstract FROM papers`);
  if (!rows.length) return res.json({ answer: "The library is empty — add some papers first.", sources: [] });
  const pick = pickPapers(question, rows, maxPapers());
  if (!pick.length) return res.json({ answer: "No papers in the library match those terms. Try rephrasing, or add relevant papers from Search.", sources: [] });
  try {
    const text = await answer(question, pick);
    res.json({ answer: text, sources: pick.map((p) => ({ id: p.id, label: p.pmid ? `PMID:${p.pmid}` : `${p.source}:${p.ext_id}`, title: p.title, year: p.year })) });
  } catch (e) { res.status(502).json({ error: describeError(e) }); }
}));

// ---------- hypothesis exploration (Scientific Research Assistant) ----------
const sourceRefs = (papers) => papers.map((p) => ({ id: p.id, label: paperLabel(p), title: p.title, year: p.year }));

app.get("/api/hypotheses", wrap(async (_req, res) => {
  const { rows } = await q(`SELECT id, author, statement, analysis, sources, model, created_at FROM hypotheses ORDER BY created_at DESC LIMIT 50`);
  res.json(rows.map((h) => ({ ...h, searches: suggestedSearches(h.analysis) })));
}));

app.post("/api/hypotheses", wrap(async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "AI is turned off (AI_PROVIDER)." });
  const statement = String(req.body?.statement || "").trim().slice(0, 2000);
  if (!statement) return res.status(400).json({ error: "State a hypothesis." });
  const { rows } = await q(`SELECT id, source, ext_id, pmid, title, journal, year, abstract FROM papers`);
  if (!rows.length) return res.status(400).json({ error: "The library is empty — add some papers first." });
  const pick = pickPapers(statement, rows, maxPapers());
  if (!pick.length) return res.status(400).json({ error: "No library papers match those terms. Add relevant papers from Search first." });
  try {
    const analysis = await exploreHypothesis(statement, pick);
    const status = aiStatus();
    const model = status.provider === "granite" ? status.model || "granite" : status.provider;
    const { rows: [h] } = await q(
      `INSERT INTO hypotheses (author, statement, analysis, sources, model) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, author, statement, analysis, sources, model, created_at`,
      [req.user, statement, analysis, JSON.stringify(sourceRefs(pick)), model],
    );
    res.status(201).json({ ...h, searches: suggestedSearches(analysis) });
  } catch (e) { res.status(502).json({ error: describeError(e) }); }
}));

app.delete("/api/hypotheses/:id", wrap(async (req, res) => {
  const { rowCount } = await q(`DELETE FROM hypotheses WHERE id=$1 AND author=$2`, [req.params.id, req.user]);
  if (!rowCount) return res.status(403).json({ error: "You can only delete your own hypotheses." });
  res.json({ ok: true });
}));

// ---------- citation graph (Scientific Research Assistant) ----------
async function storeLinks(paper) {
  const links = await fetchLinks(paper);
  for (const l of links) {
    await q(
      `INSERT INTO citation_links (citing_source, citing_ext, cited_source, cited_ext, citing_title, citing_year, cited_title, cited_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [l.citing.source, l.citing.ext_id, l.cited.source, l.cited.ext_id, l.citing.title, l.citing.year, l.cited.title, l.cited.year],
    );
  }
  await q(`UPDATE papers SET citations_fetched_at = now() WHERE id = $1`, [paper.id]);
  return links.length;
}

const GRAPH_COLS = `id, source, ext_id, pmid, title, year, topics`;
async function graphFor() {
  const papers = (await q(`SELECT ${GRAPH_COLS} FROM papers ORDER BY year NULLS LAST`)).rows;
  const links = (await q(`SELECT * FROM citation_links`)).rows;
  return buildGraph(papers, links);
}

app.get("/api/graph", wrap(async (_req, res) => {
  const g = await graphFor();
  const { rows: [c] } = await q(`SELECT count(*) FILTER (WHERE citations_fetched_at IS NULL)::int AS pending, count(*)::int AS total FROM papers`);
  res.json({ ...g, pending: c.pending, total: c.total });
}));

let graphRefreshRunning = false;
app.post("/api/graph/refresh", wrap(async (req, res) => {
  if (graphRefreshRunning) return res.status(409).json({ error: "A citation refresh is already running." });
  graphRefreshRunning = true;
  try {
    const limit = Math.min(Number(req.body?.limit) || 20, 50);
    const { rows } = await q(`SELECT ${GRAPH_COLS} FROM papers WHERE citations_fetched_at IS NULL ORDER BY added_at DESC LIMIT $1`, [limit]);
    let fetched = 0, links = 0; const failed = [];
    for (const p of rows) {
      try { links += await storeLinks(p); fetched++; } catch (e) { failed.push({ id: p.id, error: e.message }); }
    }
    res.json({ fetched, links, failed });
  } catch (e) { res.status(502).json({ error: `Citation refresh failed: ${e.message}` }); }
  finally { graphRefreshRunning = false; }
}));

app.get("/api/papers/:id/citations", wrap(async (req, res) => {
  const { rows: [p] } = await q(`SELECT ${GRAPH_COLS}, citations_fetched_at FROM papers WHERE id = $1`, [req.params.id]);
  if (!p) return res.status(404).json({ error: "Not found" });
  const g = await graphFor();
  const node = (id) => g.nodes.find((n) => n.id === id);
  const keys = [[p.source, p.ext_id], ...(p.pmid ? [["MED", p.pmid]] : [])];
  const match = (side) => keys.map((_, i) => `(${side}_source = $${2 * i + 1} AND ${side}_ext = $${2 * i + 2})`).join(" OR ");
  const counts = (await q(
    `SELECT count(*) FILTER (WHERE ${match("citing")})::int AS refs,
            count(*) FILTER (WHERE ${match("cited")})::int AS cited_by
       FROM citation_links`,
    keys.flatMap(([src, ext]) => [src, String(ext)]),
  )).rows[0];
  res.json({
    fetched_at: p.citations_fetched_at,
    cites: g.edges.filter((e) => e.from === p.id).map((e) => node(e.to)),
    cited_by: g.edges.filter((e) => e.to === p.id).map((e) => node(e.from)),
    totals: counts,
  });
}));

app.post("/api/papers/:id/citations", wrap(async (req, res) => {
  const { rows: [p] } = await q(`SELECT ${GRAPH_COLS} FROM papers WHERE id = $1`, [req.params.id]);
  if (!p) return res.status(404).json({ error: "Not found" });
  try { res.json({ links: await storeLinks(p) }); }
  catch (e) { res.status(502).json({ error: `Europe PMC lookup failed: ${e.message}` }); }
}));

// ---------- research scope ----------
const markScopeDirty = () => q(`INSERT INTO meta (key, value) VALUES ('scope_dirty', '1') ON CONFLICT (key) DO NOTHING`);
const SCOPE_COLS = `s.*, (SELECT count(*)::int FROM papers p WHERE ('scope-' || s.slug) = ANY(p.tags)) AS papers`;

function scopeInput(body) {
  const kind = String(body.kind || "");
  if (!(kind in KINDS)) throw Object.assign(new Error("Pick a type."), { status: 400 });
  const title = String(body.title || "").trim().slice(0, 200);
  if (!title) throw Object.assign(new Error("Give it a title."), { status: 400 });
  const link = String(body.link || "").trim();
  if (link && !/^https?:\/\//i.test(link)) throw Object.assign(new Error("Links must start with http:// or https://"), { status: 400 });
  return {
    kind, title, link: link || null,
    body: String(body.body || "").slice(0, 200000),
    keywords: tidyKeywords(body.keywords),
    context: body.context === "any" ? "any" : "cct",
    active: body.active !== false,
  };
}

app.get("/api/scope", wrap(async (_req, res) => {
  const { rows } = await q(`SELECT ${SCOPE_COLS} FROM scope_items s ORDER BY s.active DESC, s.updated_at DESC`);
  res.json({ kinds: KINDS, items: rows, feed: Boolean(process.env.SCOPE_FEED_KEY) });
}));

app.post("/api/scope", wrap(async (req, res) => {
  let v; try { v = scopeInput(req.body || {}); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  let slug = slugify(v.title);
  const taken = await q(`SELECT 1 FROM scope_items WHERE slug = $1`, [slug]);
  if (taken.rows[0]) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
  const { rows } = await q(
    `INSERT INTO scope_items (kind, title, slug, body, keywords, context, link, active, author)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [v.kind, v.title, slug, v.body, v.keywords, v.context, v.link, v.active, req.user],
  );
  const matched = await retag(rows[0]);
  await markScopeDirty();
  res.status(201).json({ ...rows[0], papers: matched });
}));

app.put("/api/scope/:id", wrap(async (req, res) => {
  let v; try { v = scopeInput(req.body || {}); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { rows } = await q(
    `UPDATE scope_items SET kind=$1, title=$2, body=$3, keywords=$4, context=$5, link=$6, active=$7, updated_at=now()
     WHERE id=$8 RETURNING *`,
    [v.kind, v.title, v.body, v.keywords, v.context, v.link, v.active, req.params.id],
  );
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  const matched = await retag(rows[0]);
  await markScopeDirty();
  res.json({ ...rows[0], papers: matched });
}));

app.delete("/api/scope/:id", wrap(async (req, res) => {
  const { rows } = await q(`DELETE FROM scope_items WHERE id=$1 RETURNING *`, [req.params.id]);
  if (rows[0]) await retag({ ...rows[0], active: false });
  res.json({ ok: true });
}));

// ---------- static frontend ----------
// index.html references the DDUUI chrome on Gudmundr Gateway; GATEWAY_URL lets a
// local/staging Gateway serve it instead of production.
const INDEX_HTML = fs.readFileSync(path.join(here, "..", "public", "index.html"), "utf8")
  .replaceAll("https://gateway.gudmundr.com", GATEWAY_URL);
const sendIndex = (_req, res) => res.type("html").set("Cache-Control", "no-cache").send(INDEX_HTML);
app.get("/", sendIndex);
app.use(express.static(path.join(here, "..", "public"), { index: false }));
app.get(/^\/(?!api\/|auth\/).*/, sendIndex);

// ---------- start ----------
// Adds any starter papers not yet in the library; once all are present, never runs again
// (so papers the lab deletes later stay deleted).
async function seed() {
  const { rows } = await q(`SELECT value FROM meta WHERE key='seeded'`);
  if (rows[0]) return;
  const have = new Set((await q(`SELECT pmid FROM papers WHERE pmid IS NOT NULL`)).rows.map((r) => r.pmid));
  let added = 0, missing = 0;
  for (const s of SEED) {
    if (have.has(s.pmid)) continue;
    try {
      const rec = await lookup("MED", s.pmid);
      if (rec && (await insertPaper(rec, "Starter set", ["starter"])) !== null) added++;
      else missing++;
    } catch (e) { missing++; console.warn(`seed ${s.pmid}: ${e.message}`); }
  }
  if (!missing) await q(`INSERT INTO meta (key, value) VALUES ('seeded', $1) ON CONFLICT DO NOTHING`, [new Date().toISOString()]);
  console.log(`Starter set: added ${added}, still missing ${missing}${missing ? " (will retry next start)" : ""}.`);
}

// ---------- daily auto-scan ----------
// Once a day the app pulls newly published CCT/TRiC papers and preprints from Europe PMC
// (which indexes PubMed + bioRxiv/medRxiv) into the shared library, tagged "auto".
// Papers matching the PhD proposal's focus also get the "focus" tag.
const FOCUS_RX = /mlst8|g[βb]l\b|gnb1|gnb5|g[βb] ?(1|5)\b|g[βb]γ|beta[- ]propeller|β-propeller|wd40|wd-40|anticarin|mtorc|phosducin|phlp|pdcl|cryo-?em|ring closure/i;
const DAY = 24 * 3600 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);
let scanRunning = false;

async function dailyScan({ force = false } = {}) {
  if (scanRunning) return { skipped: "already running" };
  const last = (await q(`SELECT value FROM meta WHERE key='last_scan'`)).rows[0];
  const lastAt = last ? JSON.parse(last.value) : null;
  if (!force && lastAt && Date.now() - Date.parse(lastAt.at) < 20 * 3600 * 1000) return { skipped: "ran recently", last: lastAt };
  scanRunning = true;
  try {
    // First run backfills 30 days; later runs re-check the last 7 days to catch late indexing.
    // ...or 30 days again after scope items change, so new areas of inquiry get a backfill.
    const dirty = (await q(`SELECT 1 FROM meta WHERE key='scope_dirty'`)).rows[0];
    const from = iso(new Date(Date.now() - (lastAt && !dirty ? 7 : 30) * DAY));
    const to = iso(new Date());
    // Scope items marked "any paper" widen the query beyond CCT/TRiC; all active items tag matches.
    const items = await activeItems();
    const extra = items.filter((it) => it.context === "any").map(clauseFor).filter(Boolean);
    const recs = await recent(from, to, 500, extra);
    const added = [];
    for (const rec of recs) {
      const sTags = scopeTags(rec, items);
      // Keep only papers about CCT/TRiC or matching an active scope item.
      if (!sTags.length && !isCct(rec)) continue;
      const tags = ["auto", `scan-${to}`, ...sTags];
      if (sTags.length || FOCUS_RX.test(`${rec.title} ${rec.abstract || ""}`)) tags.push("focus");
      const id = await insertPaper(rec, "Daily scan", tags);
      if (id !== null) added.push({ id, title: rec.title, focus: tags.includes("focus") });
    }
    const result = { at: new Date().toISOString(), from, to, found: recs.length, added: added.length, focus: added.filter((a) => a.focus).length };
    await q(`DELETE FROM meta WHERE key='scope_dirty'`);
    await q(`INSERT INTO meta (key, value) VALUES ('last_scan', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(result)]);
    console.log(`Daily scan ${from}..${to}: ${recs.length} found, ${added.length} added (${result.focus} focus).`);
    return result;
  } finally {
    scanRunning = false;
  }
}

app.get("/api/scan", wrap(async (_req, res) => {
  const last = (await q(`SELECT value FROM meta WHERE key='last_scan'`)).rows[0];
  res.json({ last: last ? JSON.parse(last.value) : null, running: scanRunning });
}));
app.post("/api/scan", wrap(async (_req, res) => {
  try { res.json(await dailyScan({ force: true })); }
  catch (e) { res.status(502).json({ error: `Scan failed: ${e.message}` }); }
}));

const port = Number(process.env.PORT) || 3000;
await migrate();
app.listen(port, () => { console.log(`CCT Research Hub listening on :${port}`); warmUp(); });
seed()
  .catch((e) => console.error("seed failed", e))
  .then(() => seedScope())
  .catch((e) => console.error("scope seed failed", e))
  .then(() => dailyScan())
  .catch((e) => console.error("daily scan failed", e));
// Check hourly; dailyScan() itself only runs if the last scan is more than 20 h old.
setInterval(() => dailyScan().catch((e) => console.error("daily scan failed", e)), 3600 * 1000);
