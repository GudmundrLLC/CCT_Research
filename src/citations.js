// Citation graph for the lab library, from Europe PMC's references and
// citations endpoints (same source as search, no key needed).
//   GET /rest/{source}/{id}/references → referenceList.reference[]
//   GET /rest/{source}/{id}/citations  → citationList.citation[]
// Links are stored as (citing → cited) pairs; the graph keeps library papers
// as nodes and surfaces outside papers that many library papers share.
const REST = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, fetchImpl, attempts = 3) {
  for (let i = 1; ; i++) {
    const res = await fetchImpl(url, { headers: { "User-Agent": "cct-research-hub/1.0" }, signal: AbortSignal.timeout(25000) });
    if (res.ok) return res.json();
    if (res.status === 404) return {};
    if (i >= attempts || !(res.status === 429 || res.status >= 500)) throw new Error(`Europe PMC returned ${res.status}`);
    await sleep(800 * 2 ** (i - 1));
  }
}

const toRef = (r) => r && r.id && /^(MED|PPR|PMC|AGR|CBA|CTX|ETH|HIR|PAT|NBK)$/.test(r.source || "")
  ? { source: r.source, ext_id: String(r.id), title: (r.title || "").replace(/<[^>]+>/g, "").trim() || null, year: r.pubYear ? Number(r.pubYear) : null }
  : null;

// Every outgoing reference and incoming citation of one paper, as links.
export async function fetchLinks(paper, { fetchImpl = fetch, max = 1000 } = {}) {
  const base = `${REST}/${paper.source}/${encodeURIComponent(paper.ext_id)}`;
  const qs = `?format=json&pageSize=${Math.min(max, 1000)}`;
  const [refs, cits] = await Promise.all([
    getJson(`${base}/references${qs}`, fetchImpl),
    getJson(`${base}/citations${qs}`, fetchImpl),
  ]);
  const self = { source: paper.source, ext_id: String(paper.ext_id), title: paper.title || null, year: paper.year ?? null };
  const links = [];
  for (const r of (refs.referenceList?.reference || []).map(toRef).filter(Boolean)) links.push({ citing: self, cited: r });
  for (const c of (cits.citationList?.citation || []).map(toRef).filter(Boolean)) links.push({ citing: c, cited: self });
  return links;
}

const key = (source, ext) => `${source}:${ext}`;

// papers: library rows {id, source, ext_id, pmid, title, year, topics}
// links:  rows {citing_source, citing_ext, citing_title, citing_year, cited_source, cited_ext, cited_title, cited_year}
// Europe PMC files a PubMed paper as MED:<pmid>; library preprints as PPR:<id>.
export function buildGraph(papers, links, { minShared = 2, limit = 15 } = {}) {
  const byKey = new Map();
  for (const p of papers) {
    byKey.set(key(p.source, p.ext_id), p);
    if (p.pmid) byKey.set(key("MED", p.pmid), p);
  }
  const edges = new Map();
  const outCited = new Map(); // outside papers cited by library papers
  const outCiting = new Map(); // outside papers citing library papers
  const bump = (m, k, ref, from) => {
    const e = m.get(k) || { ...ref, library_ids: new Set() };
    e.library_ids.add(from);
    m.set(k, e);
  };
  for (const l of links) {
    const a = byKey.get(key(l.citing_source, l.citing_ext));
    const b = byKey.get(key(l.cited_source, l.cited_ext));
    if (a && b && a.id !== b.id) edges.set(`${a.id}>${b.id}`, { from: a.id, to: b.id });
    else if (a && !b) bump(outCited, key(l.cited_source, l.cited_ext), { source: l.cited_source, ext_id: l.cited_ext, title: l.cited_title, year: l.cited_year }, a.id);
    else if (b && !a) bump(outCiting, key(l.citing_source, l.citing_ext), { source: l.citing_source, ext_id: l.citing_ext, title: l.citing_title, year: l.citing_year }, b.id);
  }
  const deg = new Map();
  for (const e of edges.values()) {
    deg.set(e.from, (deg.get(e.from) || 0) + 1);
    deg.set(e.to, (deg.get(e.to) || 0) + 1);
  }
  const rank = (m) => [...m.values()]
    .map(({ library_ids, ...r }) => ({ ...r, shared: library_ids.size, library_ids: [...library_ids] }))
    .filter((r) => r.shared >= minShared)
    .sort((x, y) => y.shared - x.shared || (y.year || 0) - (x.year || 0))
    .slice(0, limit);
  return {
    nodes: papers.map((p) => ({ id: p.id, title: p.title, year: p.year, label: p.pmid ? `PMID:${p.pmid}` : key(p.source, p.ext_id), topics: p.topics || [], degree: deg.get(p.id) || 0 })),
    edges: [...edges.values()],
    suggestions: { cited: rank(outCited), citing: rank(outCiting) },
  };
}
