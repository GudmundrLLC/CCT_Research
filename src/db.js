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
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
