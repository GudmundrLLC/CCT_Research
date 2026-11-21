// Human CCT/TRiC subunits. UniProt accessions verified against rest.uniprot.org.
// Live details (function, structures) are fetched from UniProt at request time.
export const SUBUNITS = [
  { id: "CCT1", gene: "TCP1", greek: "α", name: "T-complex protein 1 subunit alpha", uniprot: "P17987", aliases: ["TCP1", "CCT1", "CCTα", "CCT alpha"] },
  { id: "CCT2", gene: "CCT2", greek: "β", name: "T-complex protein 1 subunit beta", uniprot: "P78371", aliases: ["CCT2", "CCTβ", "CCT beta"] },
  { id: "CCT3", gene: "CCT3", greek: "γ", name: "T-complex protein 1 subunit gamma", uniprot: "P49368", aliases: ["CCT3", "CCTγ", "CCT gamma"] },
  { id: "CCT4", gene: "CCT4", greek: "δ", name: "T-complex protein 1 subunit delta", uniprot: "P50991", aliases: ["CCT4", "CCTδ", "CCT delta"] },
  { id: "CCT5", gene: "CCT5", greek: "ε", name: "T-complex protein 1 subunit epsilon", uniprot: "P48643", aliases: ["CCT5", "CCTε", "CCT epsilon"] },
  { id: "CCT6A", gene: "CCT6A", greek: "ζ", name: "T-complex protein 1 subunit zeta", uniprot: "P40227", aliases: ["CCT6A", "CCT6", "CCTζ", "CCT zeta"] },
  { id: "CCT6B", gene: "CCT6B", greek: "ζ-2", name: "T-complex protein 1 subunit zeta-2 (testis-specific)", uniprot: "Q92526", aliases: ["CCT6B", "CCTζ-2", "CCT zeta-2"] },
  { id: "CCT7", gene: "CCT7", greek: "η", name: "T-complex protein 1 subunit eta", uniprot: "Q99832", aliases: ["CCT7", "CCTη", "CCT eta"] },
  { id: "CCT8", gene: "CCT8", greek: "θ", name: "T-complex protein 1 subunit theta", uniprot: "P50990", aliases: ["CCT8", "CCTθ", "CCT theta"] },
];

// Well-established clients of the complex, each backed by a starter-library paper.
export const CLIENTS = [
  { name: "Actin", pmids: ["35449234"] },
  { name: "α/β-Tubulin", pmids: ["35449234", "37116473"] },
  { name: "VHL tumour suppressor", pmids: ["10635329"] },
  { name: "STAT3", pmids: ["24756126"] },
  { name: "mTORC components (mLST8, Raptor)", pmids: ["31253771"] },
  { name: "Huntingtin (polyQ) — aggregation blocked", pmids: ["16980959", "16980958", "19915590"] },
  { name: "WD40 / β-propeller proteins", pmids: ["19011634"] },
];

const cache = new Map();
const TTL = 24 * 3600 * 1000;

export async function uniprotDetails(acc) {
  const hit = cache.get(acc);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const res = await fetch(`https://rest.uniprot.org/uniprotkb/${acc}.json`, { headers: { "User-Agent": "cct-research-hub/1.0" } });
  if (!res.ok) throw new Error(`UniProt returned ${res.status}`);
  const d = await res.json();
  const fn = (d.comments || []).find((c) => c.commentType === "FUNCTION");
  const pdb = (d.uniProtKBCrossReferences || [])
    .filter((x) => x.database === "PDB")
    .map((x) => {
      const p = Object.fromEntries((x.properties || []).map((y) => [y.key, y.value]));
      return { id: x.id, method: p.Method, resolution: p.Resolution, chains: p.Chains };
    });
  const data = {
    length: d.sequence?.length,
    function: fn?.texts?.map((t) => t.value).join(" ") || null,
    pdb,
  };
  cache.set(acc, { at: Date.now(), data });
  return data;
}
