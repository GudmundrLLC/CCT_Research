# CCT Research Hub — v1 spec

Notes from the requirements interview, 2026-11-21.

## Purpose
A shared research workspace for a lab group of PhD students and their PI
studying **CCT/TRiC (chaperonin containing TCP-1)**.

## Users
- One lab: a few PhD students and a PI.
- One shared library. Everyone sees the same papers, tags and notes.

## Research focus
- Structure and mechanism: cryo-EM, the ATP cycle, the folding mechanism,
  and how CCT works with prefoldin and PhLP.
- Disease and cancer: CCT in cancer and neurodegeneration, and as a drug
  target or biomarker.
- Substrates and interactome: client proteins such as actin and tubulin,
  proteomics, and interaction networks.

## v1 features
1. **Live literature search**
   - Sources: PubMed (NCBI E-utilities), Europe PMC, and bioRxiv preprints
     through Europe PMC.
   - Preset queries for CCT/TRiC and its synonyms.
   - Filters: subunit (CCT1–CCT8, CCT6B), year, topic (structure, disease,
     substrates), and preprint vs. peer-reviewed.
   - Add any result to the library in one click.
2. **Reading list and notes** (shared)
   - Save papers with PMID, DOI, title, authors, journal, year and abstract.
   - Tags, read/unread status, who added each paper, and threaded notes for
     each paper.
3. **Subunit and structure hub**
   - One page per subunit, covering gene name, aliases, UniProt ID, key
     PDB/EMDB structures, known substrates, and linked library papers.
4. **AI summaries and Q&A**
   - Answers use **only the abstracts saved in the library** and cite them
     by PMID. If the library doesn't hold the answer, the app says so
     instead of guessing.
   - Per-paper "summarise" and library-wide "ask a question".

## Seed data
Before launch, preload 15–20 landmark CCT/TRiC papers on structure,
substrates and disease. Each paper's metadata is fetched from PubMed, so the
citations are verified. None are written from memory.

## Delivery
- Source lives in this repo (`GudmundrLLC/CCT_Research`).
- Deployed on **Railway**: a Node/Express web service plus Railway Postgres.
- Lab access uses a shared passcode plus each person's display name, which the app
  uses to record who added each paper or note and who has read it.
- AI features use the Anthropic API (`ANTHROPIC_API_KEY`); without a key, the rest of
  the app still works.
- Name: **CCT Research Hub**, with no institutional branding.

## Resolved technical choices
- All literature calls run server-side, so CORS doesn't apply.
- Europe PMC is the primary source because it covers PubMed plus preprints and returns
  abstracts in one call. PubMed E-utilities fills in missing abstracts.
- CCT and subunit search terms are restricted to title and abstract; full-text matching
  returned off-topic papers.
