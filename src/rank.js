// Pick the library abstracts most relevant to a question or hypothesis
// (shared by Ask and Explore). Plain term counting: the library is small
// and Granite only reads a handful of abstracts at a time.
const STOP = new Set("the a an of and or in on to for with by is are was were be what which how does do did that this from as at it its into about between than their there these those can could role cct tric chaperonin".split(" "));
export const terms = (s) => (String(s).toLowerCase().match(/[a-z0-9α-ω-]{3,}/g) || []).filter((t) => !STOP.has(t));

export function pickPapers(text, rows, cap) {
  const qt = terms(text);
  const scored = rows.map((p) => {
    const hay = `${p.title} ${p.title} ${p.abstract || ""}`.toLowerCase();
    return { p, score: qt.reduce((s, t) => s + (hay.split(t).length - 1), 0) };
  }).sort((a, b) => b.score - a.score);
  return (rows.length <= cap ? scored : scored.filter((x) => x.score > 0).slice(0, cap)).map((x) => x.p);
}

export const paperLabel = (p) => (p.pmid ? `PMID:${p.pmid}` : `${p.source}:${p.ext_id}`);
