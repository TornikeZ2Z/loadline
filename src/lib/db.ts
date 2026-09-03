/**
 * Database access.
 *
 * One SQL dialect, two backends:
 *   - DATABASE_URL set   -> real Postgres over `pg` (staging/production)
 *   - DATABASE_URL unset -> embedded Postgres via PGlite, persisted in ./.pgdata
 *
 * PGlite is genuine Postgres compiled to wasm, so every query in this codebase
 * is plain portable SQL. Nothing here is written against a fake/ORM dialect,
 * which is why moving to managed Postgres is a config change and not a rewrite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `object` rather than Record<string, unknown>: query result shapes are
// declared as interfaces at each call site, and interfaces have no implicit
// index signature.
export type Row = object;

export interface QueryResult<T extends Row = Row> {
  rows: T[];
}

interface Backend {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  kind: "pg" | "pglite";
}

// int8/bigint and numeric arrive as strings by default in both drivers, which
// then leak into JSON as "12" instead of 12. Parse them to numbers centrally;
// this app has no ids or money values outside the safe-integer range.
const INT8 = 20;
const NUMERIC = 1700;

let backendPromise: Promise<Backend> | null = null;

const globalForDb = globalThis as unknown as { __loadboardDb?: Promise<Backend> };

async function createPgBackend(url: string): Promise<Backend> {
  const { default: pg } = await import("pg");
  pg.types.setTypeParser(INT8, (v: string) => Number(v));
  pg.types.setTypeParser(NUMERIC, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  return {
    kind: "pg",
    async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
  };
}

/**
 * Where the embedded database lives.
 *
 * Locally that is `./.pgdata`, so a demo survives restarts. On a serverless host
 * the deployment directory is read-only and only the temp directory is
 * writable, so fall back there -- the database is then rebuilt on each cold
 * start, which for a demo deployment is acceptable and self-healing.
 * `PGLITE_DIR=memory://` forces a purely in-memory database.
 */
function pgliteDataDir(): string {
  const explicit = process.env.PGLITE_DIR;
  if (explicit) return explicit;

  const serverless = Boolean(
    process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY,
  );
  return serverless ? path.join(os.tmpdir(), "loadline-pgdata") : path.join(process.cwd(), ".pgdata");
}

async function createPgliteBackend(): Promise<Backend> {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = pgliteDataDir();
  const client = await PGlite.create({
    dataDir: dir,
    parsers: {
      [INT8]: (v: string) => Number(v),
      [NUMERIC]: (v: string) => Number(v),
    },
  });
  return {
    kind: "pglite",
    async query<T extends Row = Row>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async exec(sql: string) {
      await client.exec(sql);
    },
  };
}

async function connect(): Promise<Backend> {
  const url = process.env.DATABASE_URL;
  const backend = url ? await createPgBackend(url) : await createPgliteBackend();
  await migrate(backend);
  return backend;
}

function backend(): Promise<Backend> {
  // Reuse across Next.js hot reloads; a fresh PGlite instance per reload would
  // fight over the same data directory lock.
  if (process.env.NODE_ENV !== "production") {
    globalForDb.__loadboardDb ??= connect();
    return globalForDb.__loadboardDb;
  }
  backendPromise ??= connect();
  return backendPromise;
}

let migrated = false;

async function migrate(b: Backend): Promise<void> {
  if (migrated) return;
  migrated = true;
  const schemaPath = path.join(process.cwd(), "db", "schema.sql");
  await b.exec(fs.readFileSync(schemaPath, "utf8"));
}

/** Parameterized query. Always use $1-style placeholders, never interpolation. */
export async function query<T extends Row = Row>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const b = await backend();
  const res = await b.query<T>(sql, params);
  return res.rows;
}

/** First row, or null. */
export async function queryOne<T extends Row = Row>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}

/** Multi-statement DDL/DML. Not parameterized -- never pass user input here. */
export async function exec(sql: string): Promise<void> {
  const b = await backend();
  await b.exec(sql);
}

export async function dbKind(): Promise<"pg" | "pglite"> {
  return (await backend()).kind;
}

/**
 * Incremental placeholder builder. Keeps dynamic filter SQL readable while
 * guaranteeing every value goes through a bind parameter.
 *
 *   const p = params();
 *   sql += ` and pickup_state = ${p.add("NJ")}`;   // -> "$1"
 *   query(sql, p.values);
 */
export function params() {
  const values: unknown[] = [];
  return {
    values,
    add(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}
