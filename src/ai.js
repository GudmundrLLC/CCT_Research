import Anthropic from "@anthropic-ai/sdk";

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

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

async function ask(userText, effort) {
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
  return ask(
    `Summarise this paper for a lab reading list in 4–6 bullets: question, approach, key findings, and relevance to CCT/TRiC structure, substrates or disease.\n\n${formatPapers([paper])}`,
    "low",
  );
}

export async function answer(question, papers) {
  return ask(
    `Library abstracts (${papers.length}):\n\n${formatPapers(papers)}\n\n---\nQuestion: ${question}`,
    "medium",
  );
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "The Anthropic API key is invalid.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API — try again in a minute.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  return err.message || "AI request failed.";
}
