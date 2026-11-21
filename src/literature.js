// Literature search and record lookup via Europe PMC, which indexes PubMed
// plus bioRxiv/medRxiv preprints and returns abstracts in one call.
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";

// CCT terms must appear in the title or abstract: Europe PMC otherwise matches
// full text, where a passing mention (e.g. in a gene list) pulls in noise.
// Bare "CCT"/"TRiC" are avoided on their own (both collide with unrelated terms).
const inTA = (terms) => terms.map((t) => `TITLE:${t} OR ABSTRACT:${t}`).join(" OR ");
const BASE_TERMS = ['"chaperonin containing TCP-1"', '"chaperonin containing TCP1"', '"chaperonin-containing TCP-1"',
  '"TCP-1 ring complex"', '"TRiC/CCT"', '"CCT/TRiC"', '"T-complex protein 1"', '(TRiC AND chaperonin)', '(CCT AND chaperonin)'];
const BASE = `(${inTA(BASE_TERMS)})`;

export const SUBUNIT_TERMS = {
  CCT1: ['"CCT1"', '"TCP1"', '"TCP-1 alpha"', '"CCTalpha"', '"CCT alpha"'],
  CCT2: ['"CCT2"', '"CCTbeta"', '"CCT beta"'],
  CCT3: ['"CCT3"', '"CCTgamma"', '"CCT gamma"'],
  CCT4: ['"CCT4"', '"CCTdelta"', '"CCT delta"'],
  CCT5: ['"CCT5"', '"CCTepsilon"', '"CCT epsilon"'],
  CCT6A: ['"CCT6A"', '"CCT6"', '"CCTzeta"', '"CCT zeta"'],
  CCT6B: ['"CCT6B"', '"CCTzeta-2"', '"CCT zeta 2"'],
  CCT7: ['"CCT7"', '"CCTeta"', '"CCT eta"'],
  CCT8: ['"CCT8"', '"CCTtheta"', '"CCT theta"'],
};

export const TOPIC_TERMS = {
  structure: '("cryo-EM" OR "cryo-electron" OR "crystal structure" OR structure OR "ATP hydrolysis" OR mechanism OR prefoldin OR PhLP OR conformational)',
  disease: '(cancer OR tumor OR tumour OR carcinoma OR neurodegeneration OR huntingtin OR polyglutamine OR Alzheimer OR tau OR "drug target" OR biomarker OR prognosis)',
  substrates: '(substrate OR client OR actin OR tubulin OR interactome OR proteomics OR "WD40" OR "folding of")',
};

// Europe PMC returns entity-encoded markup (e.g. "&lt;i&gt;"); decode, then strip tags.
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const clean = (s) => decode(decode(s || "")).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

function toRecord(r) {
  return {
    source: r.source,
    ext_id: r.id,
    pmid: r.pmid || null,
    pmcid: r.pmcid || null,
    doi: r.doi || null,
    title: clean(r.title).replace(/\.$/, ""),
    authors: r.authorString || null,
    journal: r.journalInfo?.journal?.title || r.journalTitle || r.bookOrReportDetails?.publisher || (r.source === "PPR" ? "Preprint" : null),
    year: r.pubYear ? Number(r.pubYear) : null,
    abstract: clean(r.abstractText) || null,
    preprint: r.source === "PPR",
    cited_by: r.citedByCount ?? null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Europe PMC returns occasional 429/5xx under load; retry with backoff.
async function epmc(params, attempts = 4) {
  const url = `${EPMC}?${new URLSearchParams({ format: "json", resultType: "core", ...params })}`;
  for (let i = 1; ; i++) {
    const res = await fetch(url, { headers: { "User-Agent": "cct-research-hub/1.0" }, signal: AbortSignal.timeout(25000) });
    if (res.ok) return res.json();
    if (i >= attempts || !(res.status === 429 || res.status >= 500)) throw new Error(`Europe PMC returned ${res.status}`);
    await sleep(800 * 2 ** (i - 1));
  }
}

// Europe PMC occasionally lacks an abstract that PubMed has; fill it from E-utilities.
async function pubmedAbstract(pmid) {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml&id=${pmid}&tool=cct-research-hub`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const xml = await res.text();
  const parts = [...xml.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map(([, attrs, body]) => {
    const label = attrs.match(/Label="([^"]+)"/)?.[1];
    const text = clean(body);
    return label ? `${label}: ${text}` : text;
  });
  return parts.length ? parts.join("\n\n") : null;
}

export async function search({ text = "", subunit = "", topic = "", from = "", to = "", kind = "", sort = "relevance", cursor = "*" }) {
  const parts = [BASE];
  if (text.trim()) parts.push(`(${text.trim()})`);
  if (SUBUNIT_TERMS[subunit]) parts.push(`(${inTA(SUBUNIT_TERMS[subunit])})`);
  if (TOPIC_TERMS[topic]) parts.push(TOPIC_TERMS[topic]);
  if (from || to) parts.push(`PUB_YEAR:[${Number(from) || 1900} TO ${Number(to) || 2100}]`);
  if (kind === "preprint") parts.push("SRC:PPR");
  if (kind === "peer") parts.push("SRC:MED");
  else parts.push("(SRC:MED OR SRC:PPR)");
  let query = parts.join(" AND ");
  if (sort === "date") query += " sort_date:y";
  if (sort === "cited") query += " sort_cited:y";

  const data = await epmc({ query, pageSize: "25", cursorMark: cursor });
  return {
    total: data.hitCount,
    nextCursor: data.nextCursorMark && data.nextCursorMark !== cursor ? data.nextCursorMark : null,
    results: (data.resultList?.result || []).map(toRecord),
  };
}

// Fetch one canonical record so everything saved to the library is verified.
export async function lookup(source, extId) {
  if (!/^(MED|PPR)$/.test(source) || !/^[A-Za-z0-9]+$/.test(extId)) throw new Error("Invalid identifier");
  const data = await epmc({ query: `EXT_ID:${extId} AND SRC:${source}`, pageSize: "1" });
  const r = data.resultList?.result?.[0];
  if (!r) return null;
  const rec = toRecord(r);
  if (!rec.abstract && rec.pmid) rec.abstract = await pubmedAbstract(rec.pmid).catch(() => null);
  return rec;
}
