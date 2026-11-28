// Parsing helpers for hypothesis exploration (kept free of AI/DB imports so
// they are unit-testable).

// Pull the "Suggested searches" bullets out of an analysis so the UI can run them.
export function suggestedSearches(text) {
  const m = String(text).match(/suggested searches[^\n]*\n([\s\S]*?)(?:\n\s*\n|\n\**[A-Z][^\n]*\**\s*\n|$)/i);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.replace(/^\s*[-*•\d.]+\s*/, "").replace(/\[(PMID|PPR|MED):[^\]]+\]/gi, "").replace(/["“”*]/g, "").trim())
    .filter((l) => l && l.length <= 120).slice(0, 5);
}
