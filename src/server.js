import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { q, migrate } from "./db.js";
import { search, lookup } from "./literature.js";
import { SUBUNITS, CLIENTS, uniprotDetails } from "./subunits.js";
import { aiEnabled, summarize, answer, describeError } from "./ai.js";
import { SEED } from "./seed.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));

// ---------- auth: one shared lab passcode + a display name ----------
const PASSCODE = process.env.LAB_PASSCODE || "";
const SECRET = crypto.createHash("sha256").update(`cct-hub:${process.env.SESSION_SECRET || PASSCODE}`).digest();
const sign = (v) => crypto.createHmac("sha256", SECRET).update(v).digest("base64url");

function readSession(req) {
  const raw = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith("sess="))?.slice(5);
  if (!raw) return null;
  const [val, mac] = raw.split(".");
  if (!val || !mac) return null;
  const expected = sign(val);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try { return JSON.parse(Buffer.from(val, "base64url").toString()); } catch { return null; }
}

function setSession(res, name) {
  const val = Buffer.from(JSON.stringify({ name })).toString("base64url");
  res.setHeader("Set-Cookie", `sess=${val}.${sign(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}

app.post("/api/login", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 60);
  const pass = String(req.body?.passcode || "");
  if (!PASSCODE) return res.status(503).json({ error: "The lab passcode hasn't been set up yet (LAB_PASSCODE)." });
  const a = crypto.createHash("sha256").update(pass).digest();
  const b = crypto.createHash("sha256").update(PASSCODE).digest();
  if (!name) return res.status(400).json({ error: "Enter your name." });
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Wrong passcode." });
  setSession(res, name);
  res.json({ name });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api", (req, res, next) => {
  const s = readSession(req);
  if (!s?.name) return res.status(401).json({ error: "Not signed in." });
  req.user = s.name;
  next();
});

app.get("/api/me", (req, res) => res.json({ name: req.user, ai: aiEnabled() }));

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
const STOP = new Set("the a an of and or in on to for with by is are was were be what which how does do did that this from as at it its into about between than their there these those can could role cct tric chaperonin".split(" "));
const terms = (s) => (s.toLowerCase().match(/[a-z0-9α-ω-]{3,}/g) || []).filter((t) => !STOP.has(t));

app.post("/api/papers/:id/summary", wrap(async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "AI is not configured (ANTHROPIC_API_KEY)." });
  const { rows } = await q(`SELECT * FROM papers WHERE id = $1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Not found" });
  try {
    const text = await summarize(rows[0]);
    await q(`UPDATE papers SET ai_summary = $1 WHERE id = $2`, [text, req.params.id]);
    res.json({ summary: text });
  } catch (e) { res.status(502).json({ error: describeError(e) }); }
}));

app.post("/api/ask", wrap(async (req, res) => {
  if (!aiEnabled()) return res.status(503).json({ error: "AI is not configured (ANTHROPIC_API_KEY)." });
  const question = String(req.body?.question || "").trim().slice(0, 2000);
  if (!question) return res.status(400).json({ error: "Ask a question." });
  const { rows } = await q(`SELECT id, source, ext_id, pmid, title, journal, year, abstract FROM papers`);
  if (!rows.length) return res.json({ answer: "The library is empty — add some papers first.", sources: [] });
  const qt = terms(question);
  const scored = rows.map((p) => {
    const hay = `${p.title} ${p.title} ${p.abstract || ""}`.toLowerCase();
    return { p, score: qt.reduce((s, t) => s + (hay.split(t).length - 1), 0) };
  }).sort((a, b) => b.score - a.score);
  const pick = (rows.length <= 60 ? scored : scored.filter((x) => x.score > 0).slice(0, 60)).map((x) => x.p);
  if (!pick.length) return res.json({ answer: "No papers in the library match those terms. Try rephrasing, or add relevant papers from Search.", sources: [] });
  try {
    const text = await answer(question, pick);
    res.json({ answer: text, sources: pick.map((p) => ({ id: p.id, label: p.pmid ? `PMID:${p.pmid}` : `${p.source}:${p.ext_id}`, title: p.title, year: p.year })) });
  } catch (e) { res.status(502).json({ error: describeError(e) }); }
}));

// ---------- static frontend ----------
app.use(express.static(path.join(here, "..", "public")));
app.get("*", (_req, res) => res.sendFile(path.join(here, "..", "public", "index.html")));

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

const port = Number(process.env.PORT) || 3000;
await migrate();
app.listen(port, () => console.log(`CCT Research Hub listening on :${port}`));
seed().catch((e) => console.error("seed failed", e));
