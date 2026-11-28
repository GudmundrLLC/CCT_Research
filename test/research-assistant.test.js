// Scientific Research Assistant (merged into CCT Research 2026-11-28):
// citation graph, hypothesis parsing, shared paper ranking. Pure modules only;
// no database or AI needed.  Run: npm test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fetchLinks, buildGraph } from "../src/citations.js";
import { suggestedSearches } from "../src/hypothesis.js";
import { pickPapers, paperLabel, terms } from "../src/rank.js";

const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("fetchLinks turns Europe PMC references and citations into citing→cited links", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes("/references")) return jsonRes({ referenceList: { reference: [
      { source: "MED", id: "111", title: "Ref <i>one</i>", pubYear: 2001 },
      { source: "MED", title: "no id, skipped" },
    ] } });
    return jsonRes({ citationList: { citation: [{ source: "PPR", id: "PPR9", title: "Citer", pubYear: 2025 }] } });
  };
  const links = await fetchLinks({ source: "MED", ext_id: "222", title: "Self", year: 2010 }, { fetchImpl });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((u) => u.startsWith("https://www.ebi.ac.uk/europepmc/webservices/rest/MED/222/")));
  assert.deepEqual(links, [
    { citing: { source: "MED", ext_id: "222", title: "Self", year: 2010 }, cited: { source: "MED", ext_id: "111", title: "Ref one", year: 2001 } },
    { citing: { source: "PPR", ext_id: "PPR9", title: "Citer", year: 2025 }, cited: { source: "MED", ext_id: "222", title: "Self", year: 2010 } },
  ]);
});

test("fetchLinks treats 404 as no links and surfaces other errors", async () => {
  assert.deepEqual(await fetchLinks({ source: "PPR", ext_id: "X" }, { fetchImpl: async () => jsonRes({}, 404) }), []);
  await assert.rejects(fetchLinks({ source: "MED", ext_id: "1" }, { fetchImpl: async () => jsonRes({}, 400) }), /400/);
});

const L = (cs, ce, ds, de, extra = {}) => ({ citing_source: cs, citing_ext: ce, cited_source: ds, cited_ext: de, ...extra });

test("buildGraph links library papers (matching MED:<pmid>) and ranks shared outside papers", () => {
  const papers = [
    { id: 1, source: "MED", ext_id: "100", pmid: "100", title: "A", year: 2010, topics: ["structure"] },
    { id: 2, source: "MED", ext_id: "200", pmid: "200", title: "B", year: 2015, topics: [] },
    { id: 3, source: "PPR", ext_id: "PPR3", pmid: null, title: "C", year: 2024, topics: [] },
  ];
  const links = [
    L("MED", "200", "MED", "100"), L("MED", "200", "MED", "100"), // duplicate edge collapses
    L("PPR", "PPR3", "MED", "200"),
    L("MED", "100", "MED", "999", { cited_title: "Classic", cited_year: 1999 }),
    L("MED", "200", "MED", "999", { cited_title: "Classic", cited_year: 1999 }),
    L("MED", "100", "MED", "555"), // only one library paper cites it: below minShared
    L("MED", "777", "MED", "100", { citing_title: "Newer", citing_year: 2026 }),
    L("MED", "777", "PPR", "PPR3", { citing_title: "Newer", citing_year: 2026 }),
  ];
  const g = buildGraph(papers, links);
  assert.deepEqual(g.edges, [{ from: 2, to: 1 }, { from: 3, to: 2 }]);
  assert.equal(g.nodes.find((n) => n.id === 2).degree, 2);
  assert.equal(g.nodes.find((n) => n.id === 3).label, "PPR:PPR3");
  assert.deepEqual(g.suggestions.cited.map((r) => [r.ext_id, r.shared, r.title]), [["999", 2, "Classic"]]);
  assert.deepEqual(g.suggestions.citing.map((r) => [r.ext_id, r.shared]), [["777", 2]]);
  assert.deepEqual(g.suggestions.citing[0].library_ids.sort(), [1, 3]);
});

test("suggestedSearches reads Claude and Granite style analyses", () => {
  const claude = "**Supporting evidence**\n- x [PMID:1]\n\n**Suggested searches**\n- \"CCT4 mLST8 folding\"\n- Gbeta5 TRiC cryo-EM [PMID:2]\n\n**Possible experiments**\n- y";
  assert.deepEqual(suggestedSearches(claude), ["CCT4 mLST8 folding", "Gbeta5 TRiC cryo-EM"]);
  const granite = "Supporting evidence\n- a [PMID:1]\nSuggested searches\n- PhLP1 Gbeta folding\n- WD40 chaperonin";
  assert.deepEqual(suggestedSearches(granite), ["PhLP1 Gbeta folding", "WD40 chaperonin"]);
  assert.deepEqual(suggestedSearches("no such section"), []);
});

test("pickPapers ranks by term hits and caps only large libraries", () => {
  const rows = [
    { id: 1, title: "Tubulin folding", abstract: "tubulin tubulin" },
    { id: 2, title: "Actin", abstract: "actin folding" },
    { id: 3, title: "Other", abstract: "" },
  ];
  assert.deepEqual(pickPapers("tubulin folding", rows, 2).map((p) => p.id), [1, 2]);
  assert.deepEqual(pickPapers("tubulin", rows, 5).map((p) => p.id)[0], 1);
  assert.equal(pickPapers("tubulin", rows, 5).length, 3);
  assert.deepEqual(terms("What is the role of CCT in tubulin?"), ["tubulin"]);
  assert.equal(paperLabel({ pmid: "5", source: "MED", ext_id: "5" }), "PMID:5");
  assert.equal(paperLabel({ pmid: null, source: "PPR", ext_id: "PPR1" }), "PPR:PPR1");
});

test("the Explore tab is wired into the page and menu", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(html, /data-tab="explore"/);
  for (const id of ["tab-explore", "hyp-form", "hyp-out", "hyp-list", "graph", "graph-refresh", "graph-cited", "graph-citing"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(js, /\/api\/hypotheses/);
  assert.match(js, /\/api\/graph/);
  assert.match(js, /"ask", "explore"\]/);
});
