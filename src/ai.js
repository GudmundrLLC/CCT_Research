import Anthropic from "@anthropic-ai/sdk";
import { generate, graniteStatus, loadGranite, GRANITE_MODEL } from "./granite.js";

// AI provider: "granite" (default) runs IBM Granite inside the app, with no API key.
// "claude" uses the Anthropic API and needs ANTHROPIC_API_KEY. "off" disables AI.
export const PROVIDER = (process.env.AI_PROVIDER || "granite").toLowerCase();
export const aiEnabled = () =>
  PROVIDER === "granite" || (PROVIDER === "claude" && Boolean(process.env.ANTHROPIC_API_KEY));
export function aiStatus() {
  if (PROVIDER === "granite") return { provider: "granite", label: "IBM Granite (runs in the app)", ...graniteStatus() };
  if (PROVIDER === "claude") return { provider: "claude", label: "Claude (Anthropic API)", status: aiEnabled() ? "ready" : "error", error: aiEnabled() ? null : "ANTHROPIC_API_KEY is not set" };
  return { provider: "off", status: "off" };
}
// Start downloading/loading Granite in the background so the first request is fast.
export function warmUp() {
  if (PROVIDER === "granite" && process.env.GRANITE_PRELOAD !== "false") loadGranite().catch(() => {});
}
// Small local models handle fewer abstracts at once; Claude takes many.
export const maxPapers = () => (PROVIDER === "granite" ? Number(process.env.GRANITE_MAX_PAPERS || 8) : 60);

let client;
const getClient = () => (client ??= new Anthropic());

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const SYSTEM = `You are a research assistant for a lab of PhD students studying the eukaryotic chaperonin CCT/TRiC (chaperonin containing TCP-1).
You answer ONLY from the paper abstracts supplied in the user's message. Each abstract is labelled with an ID such as [PMID:12345678] or [PPR:PPR123].
Rules:
- Every factual sentence must cite at least one supplied ID in square brackets, exactly as labelled, e.g. [PMID:22503819].
- Do not use outside knowledge. If the abstracts do not answer the question, say so plainly and suggest what to search for.
- Abstracts are summaries; flag where a claim would need the full text to confirm.
- Be concise and precise, written for a PhD-level reader. Use short paragraphs or bullets.`;

const label = (p) => (p.pmid ? `PMID:${p.pmid}` : `${p.source}:${p.ext_id}`);

function formatPapers(papers) {
  return papers
    .map((p) => `[${label(p)}] ${p.title} (${p.journal || "?"}, ${p.year || "?"})\n${p.abstract || "(no abstract available)"}`)
    .join("\n\n");
}

// Granite gets a shorter, more explicit instruction set suited to a 1B model.
const GRANITE_SYSTEM = `You are a research assistant for a lab studying the chaperonin CCT/TRiC.
Use ONLY the abstracts provided. Each abstract starts with an ID in square brackets, like [PMID:12345678].
End every bullet or sentence with the ID of the abstract it comes from, in square brackets, e.g. [PMID:16980959].
If the abstracts do not contain the answer, say "The library abstracts do not answer this." Do not guess.`;

async function ask(userText, effort) {
  if (PROVIDER === "granite") {
    return generate(
      [{ role: "system", content: GRANITE_SYSTEM }, { role: "user", content: userText }],
      { maxNewTokens: effort === "low" ? 300 : 450 },
    );
  }
  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    messages: [{ role: "user", content: userText }],
  });
  if (response.stop_reason === "refusal") {
    throw new Error("The model declined to answer this request.");
  }
  return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

export async function summarize(paper) {
  if (PROVIDER === "granite") {
    const text = await ask(
      `Summarise this abstract as exactly 4 lines, each starting with "- ":\n- Question:\n- Approach:\n- Key finding:\n- Relevance to CCT/TRiC:\n\n${formatPapers([paper])}`,
      "low",
    );
    // Drop echoed empty template lines such as "- Question:".
    return text.split("\n").filter((l) => !/^\s*[-*]\s*[^:]{1,40}:\s*$/.test(l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  return ask(
    `Summarise this paper for a lab reading list in 4–6 bullets: question, approach, key findings, and relevance to CCT/TRiC structure, substrates or disease.\n\n${formatPapers([paper])}`,
    "low",
  );
}

export async function answer(question, papers) {
  const text = await ask(
    `Library abstracts (${papers.length}):\n\n${formatPapers(papers)}\n\n---\nQuestion: ${question}\n\nAnswer in 2–5 short bullets. End each bullet with the [PMID:...] it comes from.`,
    "medium",
  );
  // Small models sometimes drop the inline citations; say so instead of presenting an uncited answer as cited.
  if (PROVIDER === "granite" && !/\[(PMID|PPR|MED):/i.test(text)) {
    return `${text}\n\nNote: the model did not cite specific papers inline; the answer is drawn only from the library abstracts listed below.`;
  }
  return text;
}

// Hypothesis exploration: weigh a lab hypothesis against the library abstracts.
// Same provider switch and citation rules as answer(); nothing is added beyond
// what the abstracts say, and gaps become suggested searches.
export async function exploreHypothesis(statement, papers) {
  const granite = PROVIDER === "granite";
  const text = await ask(
    `Library abstracts (${papers.length}):\n\n${formatPapers(papers)}\n\n---\nHypothesis: ${statement}\n\n` +
      (granite
        ? `Weigh the hypothesis using only these abstracts. Write four short parts, each a heading line then 1-3 bullets ending with the [PMID:...] used:\nSupporting evidence\nContradicting evidence\nOpen gaps\nSuggested searches (plain search terms, no citation needed)`
        : `Evaluate the hypothesis strictly from these abstracts. Use these headings, each followed by bullets:\n**Supporting evidence**\n**Contradicting or complicating evidence**\n**Open gaps** (what the abstracts cannot settle; note where full text is needed)\n**Suggested searches** (3-5 Europe PMC search phrases that would close the gaps)\n**Possible experiments** (1-3, each tied to a cited finding)\nEvery evidence bullet must cite the abstract IDs it relies on. Do not rate the hypothesis as proven.`),
    "medium",
  );
  if (granite && !/\[(PMID|PPR|MED):/i.test(text)) {
    return `${text}\n\nNote: the model did not cite specific papers inline; the analysis is drawn only from the library abstracts listed below.`;
  }
  return text;
}

export function describeError(err) {
  if (PROVIDER === "granite") return `Granite (${GRANITE_MODEL}): ${err.message}`;
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key is invalid.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API — try again in a minute.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  return err.message || "AI request failed.";
}
