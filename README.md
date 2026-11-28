# CCT Research Hub

A shared literature workspace for a lab of PhD students studying the eukaryotic
chaperonin **CCT/TRiC** (chaperonin containing TCP-1).

- **Search**: live search of PubMed and bioRxiv/medRxiv preprints (via Europe PMC), scoped to
  CCT/TRiC, with filters for subunit (CCT1–CCT8, CCT6B), topic (structure & mechanism,
  disease & cancer, substrates & interactome), year, and preprint vs. peer-reviewed.
- **Shared library**: one lab-wide reading list with tags, auto-assigned topics, per-person
  read status, threaded notes on each paper, and BibTeX export.
- **Subunit hub**: a page per human subunit with live UniProt function text, every PDB
  structure UniProt lists, and the library papers that mention it.
- **Ask the library and AI summaries, run by IBM Granite inside the app.**
  - **Model:** IBM Granite 4.0 1B (Apache-2.0) runs in the app server through Transformers.js /
    ONNX Runtime on CPU.
  - **Cost and privacy:** free, with no API key, and no lab data leaves the server.
  - **Answers:** drawn only from the saved abstracts, with each point cited by PMID.
  - **Speed:** on CPU a summary takes about 20–35 s, and a library question about 60–70 s.
  - **Claude:** still available. Set `AI_PROVIDER=claude` plus `ANTHROPIC_API_KEY`.
- **Explore (Scientific Research Assistant, merged into this app 2026-11-28)**:
  - **Hypothesis exploration:** state a hypothesis and the AI weighs it against the library
    abstracts only: supporting and contradicting evidence (each cited by PMID), open gaps,
    suggested searches (one click runs them in Search) and possible experiments. Results are
    saved for the lab; authors can delete their own.
  - **Citation graph:** reference and citation lists come from Europe PMC (no key). The graph
    shows which library papers cite each other, and lists outside papers that two or more
    library papers cite (or that cite two or more library papers), with one-click Add. Each
    paper's drawer shows its in-library citations. **Fetch citations** pulls data for up to 20
    papers at a time.
- **Daily auto-scan**: once a day the server adds newly published CCT/TRiC papers and preprints
  from Europe PMC to the library. They are tagged `#auto`; papers that match the proposal's focus
  (mLST8, Gβ1/Gβ5, β-propeller/WD40, Anticarin, mTORC, PhLP, cryo-EM, ring closure) are also
  tagged `#focus`. The first run backfills 30 days, and each later run re-checks the past 7 days
  to catch late-indexed papers. The Library tab has a **Check now** button.
- **Research scope** (Scope tab): proposals, areas of inquiry, concepts, methods and lab notes.
  - Each active item's search terms widen the daily scan. "Any paper" items reach beyond
    CCT/TRiC.
  - Each item tags matching papers `#scope-<name>`.
  - The scheduled Drive reports read the whole list, through a key-protected export at
    `/api/scope/export.md`, as extra search scope and context.
  - The tab starts with Aaron's third-year proposal, its aims as areas of inquiry, and the
    proposal's methods.
- **Starter set**: 18 landmark papers (structure, substrates, disease) are loaded on first
  boot. Every PMID was verified against PubMed, and metadata is fetched live, never typed in.

## Deploy on Railway

1. Create a project from this GitHub repo.
2. Add a database: **+ New → Database → PostgreSQL**.
3. On the web service, set these variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `LAB_PASSCODE` = a passcode to share with the lab
   - AI runs by default with IBM Granite inside the app. It needs about 3 GB RAM, plus a
     one-time 1.8 GB model download from Hugging Face on first start. Optional settings:
     - `GRANITE_MODEL`: defaults to `onnx-community/granite-4.0-1b-ONNX-web`. If memory is
       under 3 GB, use `onnx-community/granite-4.0-350m-ONNX-web` (about 1 GB RAM, lower quality).
     - `GRANITE_DTYPE`: defaults to `q4`.
     - `GRANITE_MAX_PAPERS`: how many abstracts each question uses; default 8.
     - `GRANITE_PRELOAD=false`: load the model on the first request instead of at startup.
     - `GRANITE_CACHE`: where the weights are stored.
     - Attach a Railway volume and the weights are kept on it automatically, so redeploys
       don't download them again.
   - `AI_PROVIDER=claude` with `ANTHROPIC_API_KEY` uses Claude instead; `AI_PROVIDER=off` disables AI.
   - `SCOPE_FEED_KEY` (optional) is a long random string. It lets the scheduled research
     reports read the Scope tab, using the `X-Scope-Key` header.
4. Under **Settings → Networking → Generate Domain**, create a public URL.

`railway.json` sets the start command and a health check on `/api/health`.

## Run locally

```bash
npm ci
DATABASE_URL=postgresql://... LAB_PASSCODE=test npm start
```

Then open http://localhost:3000. Requires Node 20 or later and Postgres.

## How it works

| Piece | Where |
|---|---|
| Express API and auth (Gudmundr Gateway SSO; lab passcode enrolls an account once and stays as a fallback; HMAC-signed cookie) | `src/server.js` |
| Gateway SSO: JWT verification against Gateway JWKS, per-app membership | `src/gateway.js` |
| Europe PMC search and PubMed abstract fallback | `src/literature.js` |
| Subunit table (UniProt accessions verified) and UniProt lookups | `src/subunits.js` |
| AI provider switch, prompts, and Claude calls | `src/ai.js` |
| In-app IBM Granite: resumable weight download, loading, one-at-a-time generation queue | `src/granite.js` |
| Postgres schema (papers, notes, reads) | `src/db.js` |
| Starter set PMIDs | `src/seed.js` |
| Citation graph: Europe PMC references/citations, graph building | `src/citations.js` |
| Library ranking shared by Ask and Explore; hypothesis parsing | `src/rank.js`, `src/hypothesis.js` |
| Tests for the pure modules (`npm test`) | `test/` |
| Frontend (no build step) | `public/` |

AI answers are generated from abstracts only. Check claims against the full text before
relying on them.

## Gudmundr ecosystem integration (2026-11-22)

- **Sign-in** goes through Gudmundr Gateway (`/auth/gateway/start` → Gateway → `/auth/gateway/callback`).
  The Gateway token (RS256 JWT) is verified against `${GATEWAY_URL}/jwks.json`. Identity is
  shared across Gudmundr apps; lab access is decided here: an email in the `members` table, in
  `LAB_MEMBER_EMAILS`, or granted `cct_research` in Gateway `/svc/perms`. New accounts enter the
  lab passcode once to join. The old name + passcode sign-in stays as a fallback.
- **Look and layout** come from the shared DDUUI chrome served by Gateway
  (`/svc/dduui/tokens.css?theme=lumen`, `/static/dduui/chrome.{css,js}`): topbar, page menu in
  the left rail (bottom dock on phones), ecosystem apps + appearance in the right rail, bottom
  bar and sub-bar. `public/styles.css` uses `--preset-*` tokens only (light and dark).
- Listed in the Gudmundr app catalog (`gudmundr.com/beta.html`, Gateway `/svc/ecosystem/apps`).

