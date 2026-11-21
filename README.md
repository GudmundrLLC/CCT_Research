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
- **Ask the library** (optional): Claude answers questions *only* from the saved abstracts
  and cites each claim by PMID; per-paper AI summaries.
- **Daily auto-scan**: once a day the server adds newly published CCT/TRiC papers and preprints
  from Europe PMC to the library. They are tagged `#auto`; papers that match the proposal's focus
  (mLST8, Gβ1/Gβ5, β-propeller/WD40, Anticarin, mTORC, PhLP, cryo-EM, ring closure) are also
  tagged `#focus`. The first run backfills 30 days, and each later run re-checks the past 7 days
  to catch late-indexed papers. The Library tab has a **Check now** button.
- **Starter set**: 18 landmark papers (structure, substrates, disease) are loaded on first
  boot. Every PMID was verified against PubMed, and metadata is fetched live, never typed in.

## Deploy on Railway

1. Create a project from this GitHub repo.
2. Add a database: **+ New → Database → PostgreSQL**.
3. On the web service, set these variables:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `LAB_PASSCODE` = a passcode to share with the lab
   - `ANTHROPIC_API_KEY` (optional) enables AI summaries and Q&A
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
| Express API and auth (shared passcode plus display name, HMAC-signed cookie) | `src/server.js` |
| Europe PMC search and PubMed abstract fallback | `src/literature.js` |
| Subunit table (UniProt accessions verified) and UniProt lookups | `src/subunits.js` |
| Claude calls (Opus 5.5, answers only from abstracts, with refusal fallback) | `src/ai.js` |
| Postgres schema (papers, notes, reads) | `src/db.js` |
| Starter set PMIDs | `src/seed.js` |
| Frontend (no build step) | `public/` |

AI answers are generated from abstracts only. Check claims against the full text before
relying on them.
