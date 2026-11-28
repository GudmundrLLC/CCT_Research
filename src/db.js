import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. Add a Postgres database (on Railway: + New → Database → PostgreSQL) and reference its DATABASE_URL.");
  process.exit(1);
}

// Railway's internal network doesn't use TLS; public proxy URLs do.
const needsSsl = /sslmode=require/.test(connectionString) || /proxy\.rlwy\.net/.test(connectionString);
export const pool = new pg.Pool({
  connectionString,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 5,
});

export const q = (text, params) => pool.query(text, params);

export async function migrate() {
  await q(`
    CREATE TABLE IF NOT EXISTS papers (
      id          SERIAL PRIMARY KEY,
      source      TEXT NOT NULL,            -- 'MED' (PubMed) or 'PPR' (preprint)
      ext_id      TEXT NOT NULL,            -- PMID or Europe PMC preprint id
      pmid        TEXT,
      pmcid       TEXT,
      doi         TEXT,
      title       TEXT NOT NULL,
      authors     TEXT,
      journal     TEXT,
      year        INTEGER,
      abstract    TEXT,
      topics      TEXT[] NOT NULL DEFAULT '{}',
      tags        TEXT[] NOT NULL DEFAULT '{}',
      added_by    TEXT NOT NULL,
      added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      ai_summary  TEXT,
      UNIQUE (source, ext_id)
    );
    CREATE TABLE IF NOT EXISTS notes (
      id          SERIAL PRIMARY KEY,
      paper_id    INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      author      TEXT NOT NULL,
      body        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS reads (
      paper_id    INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      reader      TEXT NOT NULL,
      read_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (paper_id, reader)
    );
    CREATE TABLE IF NOT EXISTS scope_items (
      id          SERIAL PRIMARY KEY,
      kind        TEXT NOT NULL,            -- proposal | inquiry | concept | method | note
      title       TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,     -- stable library tag: scope-<slug>
      body        TEXT NOT NULL DEFAULT '',
      keywords    TEXT[] NOT NULL DEFAULT '{}',
      context     TEXT NOT NULL DEFAULT 'cct', -- cct: only CCT/TRiC papers; any: any paper
      link        TEXT,
      active      BOOLEAN NOT NULL DEFAULT true,
      author      TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Lab members linked through Gudmundr Gateway SSO (2026-11-22).
    CREATE TABLE IF NOT EXISTS members (
      email         TEXT PRIMARY KEY,         -- Gateway-verified email (lower-case)
      display_name  TEXT NOT NULL,            -- name shown on notes / reads
      enrolled_by   TEXT NOT NULL,            -- passcode | gateway-grant
      enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    -- Scientific Research Assistant (merged 2026-11-28): citation graph + hypotheses.
    ALTER TABLE papers ADD COLUMN IF NOT EXISTS citations_fetched_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS citation_links (
      citing_source TEXT NOT NULL,
      citing_ext    TEXT NOT NULL,
      cited_source  TEXT NOT NULL,
      cited_ext     TEXT NOT NULL,
      citing_title  TEXT,
      citing_year   INTEGER,
      cited_title   TEXT,
      cited_year    INTEGER,
      PRIMARY KEY (citing_source, citing_ext, cited_source, cited_ext)
    );
    CREATE INDEX IF NOT EXISTS citation_links_cited ON citation_links (cited_source, cited_ext);
    CREATE TABLE IF NOT EXISTS hypotheses (
      id          SERIAL PRIMARY KEY,
      author      TEXT NOT NULL,
      statement   TEXT NOT NULL,
      analysis    TEXT NOT NULL,
      sources     JSONB NOT NULL DEFAULT '[]',
      model       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
