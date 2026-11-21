// Lab research scope: proposals, areas of inquiry, concepts, methods and lab notes.
// Active items widen the daily paper scan (via their keywords) and are exported to the
// scheduled Claude research runs as extra scope and context.
import { q } from "./db.js";
import { inTA } from "./literature.js";

export const KINDS = {
  proposal: "Proposals",
  inquiry: "Areas of inquiry",
  concept: "Concepts",
  method: "Methods",
  note: "Lab notes",
};

const CCT_RX = /chaperonin|\bTRiC\b|TCP-?1|\bCCT\d?[A-B]?\b|T-complex/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const GREEK = { α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ζ: "zeta", η: "eta", θ: "theta" };
export const slugify = (s) =>
  s.toLowerCase().replace(/[α-θ]/g, (c) => GREEK[c] || c).normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";

export function tidyKeywords(list) {
  return [...new Set((Array.isArray(list) ? list : String(list || "").split(/[,;\n]/))
    .map((k) => String(k).replace(/["()\[\]]/g, "").trim()).filter((k) => k.length >= 2))].slice(0, 25);
}

// Europe PMC clause for one item's keywords (title/abstract only, to avoid full-text noise).
// Non-ASCII terms (e.g. "Gβ5") are left out of the remote query: Europe PMC drops the Greek
// letter and the leftover ("G 5") matches unrelated papers. They still apply to local matching.
export const clauseFor = (item) => {
  const ascii = item.keywords.filter((k) => /^[\x20-\x7e]+$/.test(k));
  return ascii.length ? inTA(ascii.map((k) => `"${k}"`)) : null;
};

// Is this record actually about CCT/TRiC (title/abstract)?
const CCT_STRICT = /chaperonin[- ]containing (TCP-?1|t-complex)|TCP-?1 ring complex|TRiC\s*\/\s*CCT|CCT\s*\/\s*TRiC|T-complex protein[- ]1|\b(TRiC|CCT\d?[AB]?)\b[\s\S]*chaperonin|chaperonin[\s\S]*\b(TRiC|CCT\d?[AB]?)\b/i;
export const isCct = (rec) => CCT_STRICT.test(`${rec.title} ${rec.abstract || ""}`);

function matcher(item) {
  const rx = new RegExp(`(^|[^\\p{L}\\p{N}])(${item.keywords.map(esc).join("|")})([^\\p{L}\\p{N}]|$)`, "iu");
  return (text) => rx.test(text) && (item.context === "any" || CCT_RX.test(text));
}

export async function activeItems() {
  const { rows } = await q(`SELECT * FROM scope_items WHERE active AND cardinality(keywords) > 0 ORDER BY id`);
  return rows;
}

// Tags a record should get from the active scope items it matches.
export function scopeTags(rec, items) {
  const text = `${rec.title} ${rec.abstract || ""}`;
  return items.filter((it) => matcher(it)(text)).map((it) => `scope-${it.slug}`);
}

// Re-apply one item's tag across the whole library (after create/edit/delete).
export async function retag(item) {
  const tag = `scope-${item.slug}`;
  await q(`UPDATE papers SET tags = array_remove(tags, $1) WHERE $1 = ANY(tags)`, [tag]);
  if (!item || !item.active || !item.keywords?.length) return 0;
  const match = matcher(item);
  const { rows } = await q(`SELECT id, title, abstract FROM papers`);
  const ids = rows.filter((p) => match(`${p.title} ${p.abstract || ""}`)).map((p) => p.id);
  if (ids.length) await q(`UPDATE papers SET tags = array_append(tags, $1) WHERE id = ANY($2) AND NOT ($1 = ANY(tags))`, [tag, ids]);
  return ids.length;
}

// Markdown export read by the scheduled research runs.
export async function exportMarkdown() {
  const { rows } = await q(`SELECT s.*, (SELECT count(*)::int FROM papers p WHERE ('scope-' || s.slug) = ANY(p.tags)) AS papers
                            FROM scope_items s WHERE s.active ORDER BY s.kind, s.updated_at DESC`);
  const lines = [
    "# Lab research scope (CCT Research Hub)",
    "",
    `Exported ${new Date().toISOString()}. Active items only.`,
    "",
    "How to use this export:",
    "- Treat areas of inquiry, concepts and methods as additional search scope.",
    "- Treat proposals and lab notes as reading context.",
    "- Keywords marked 'any paper' should be searched even outside CCT/TRiC.",
    "",
  ];
  for (const [kind, label] of Object.entries(KINDS)) {
    const items = rows.filter((r) => r.kind === kind);
    if (!items.length) continue;
    lines.push(`## ${label}`, "");
    for (const it of items) {
      lines.push(`### ${it.title}`);
      lines.push(`_Added by ${it.author}; updated ${it.updated_at.toISOString().slice(0, 10)}; ${it.papers} library papers matched._`);
      if (it.keywords.length) lines.push(`Keywords (${it.context === "any" ? "any paper" : "only with CCT/TRiC"}): ${it.keywords.join("; ")}`);
      if (it.link) lines.push(`Link: ${it.link}`);
      if (it.body) lines.push("", it.body);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// Starter scope from Aaron Wilson's 2026–27 integrated third-year proposal.
const STARTER = [
  { kind: "proposal", title: "Third-year proposal 2026–27: selective modulation and robustness of CCT", context: "cct",
    keywords: ["mLST8", "GNB5", "GNB1", "anticarin"],
    body: `PhD third-year proposal (BYU, mentor Dr. Barry M. Willardson).
Central hypothesis: CCT's folding behaviour can be selectively modulated without mutating the chaperonin itself, through substrate mutations or small-molecule inhibitors such as Anticarin β.

Aim 1: mechanism of CCT-mediated folding of β-propeller substrates (mLST8). Cryo-EM of intermediates (HEK293 TAP, AlFx/ATP closed-state trapping), co-IP and stability assays.

Aim 2: how Anticarin β modulates CCT. ATPase inhibition (malachite green), partially closed state, DSSO cross-linking MS binding sites, cryo-EM of bound complexes, actin/tubulin folding readouts.

Aim 3: folding-pathway selectivity with Gβ1, Gβ5 and Gβ5 mutants (R269E, R311A/E). Gβ5 initiates at CCT5 via R269–E256; Gβ1 at CCT2.` },
  { kind: "inquiry", title: "β-propeller / WD40 folding by CCT", context: "cct",
    keywords: ["beta-propeller", "β-propeller", "WD40", "WD-40", "mLST8", "GβL", "Raptor", "GNB1", "GNB5", "Gβ5", "Gβ1"],
    body: "How CCT folds seven-bladed β-propellers; initiation sites, intermediates, co-chaperones (PhLP1, prefoldin)." },
  { kind: "inquiry", title: "mLST8 and mTORC1/mTORC2 assembly", context: "any",
    keywords: ["mLST8", "GβL", "mTORC2 assembly", "mTORC1 assembly"],
    body: "mLST8 biogenesis and its role in mTOR complex assembly and oncogenic signalling, including outside the CCT literature." },
  { kind: "inquiry", title: "Gβ5–RGS and Gβγ biogenesis", context: "any",
    keywords: ["GNB5", "Gβ5", "RGS9", "RGS7", "phosducin-like protein", "PhLP1", "PDCL"],
    body: "Gβ5 folding and assembly with R7-family RGS proteins; PhLP1-assisted Gβγ assembly; R269E and R311A/E mutants." },
  { kind: "inquiry", title: "CCT inhibitors and chemical modulation", context: "any",
    keywords: ["anticarin", "CT20 peptide", "chaperonin inhibitor", "TRiC inhibitor", "CCT inhibitor"],
    body: "Anticarin β and analogues, CT20 peptide, small molecules or peptides that disrupt TRiC/CCT; selectivity and therapeutic windows." },
  { kind: "concept", title: "Mutation-resistant therapy via chaperone-dependent biogenesis", context: "cct",
    keywords: ["drug resistance", "therapy resistance", "mTOR inhibitor", "kinase inhibitor"],
    body: "Targeting the folding and assembly of oncogenic complexes, instead of the kinase itself, to sidestep resistance mutations." },
  { kind: "method", title: "Cryo-EM / cryo-ET of folding intermediates", context: "cct",
    keywords: ["cryo-EM", "cryo-electron microscopy", "cryo-ET", "cryo-electron tomography"],
    body: "Capturing CCT–substrate intermediates; closed-state trapping (AlFx/ATP); time-resolved and in-situ approaches." },
  { kind: "method", title: "Cross-linking mass spectrometry (XL-MS, DSSO)", context: "cct",
    keywords: ["cross-linking mass spectrometry", "crosslinking mass spectrometry", "XL-MS", "DSSO"],
    body: "Mapping inhibitor and substrate binding interfaces on CCT." },
  { kind: "method", title: "ATPase, folding and stability assays", context: "cct",
    keywords: ["ATPase activity", "malachite green", "thermal stability", "limited proteolysis", "co-immunoprecipitation"],
    body: "Malachite green ATPase assays, actin/tubulin folding assays, thermal shift, limited proteolysis, co-IP retention." },
];

export async function seedScope() {
  const { rows } = await q(`SELECT value FROM meta WHERE key='scope_seeded'`);
  if (rows[0]) return;
  for (const it of STARTER) {
    const { rows: r } = await q(
      `INSERT INTO scope_items (kind, title, slug, body, keywords, context, author)
       VALUES ($1,$2,$3,$4,$5,$6,'Starter scope') ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [it.kind, it.title, slugify(it.title), it.body, tidyKeywords(it.keywords), it.context],
    );
    if (r[0]) await retag(r[0]);
  }
  await q(`INSERT INTO meta (key, value) VALUES ('scope_seeded', $1) ON CONFLICT DO NOTHING`, [new Date().toISOString()]);
}
