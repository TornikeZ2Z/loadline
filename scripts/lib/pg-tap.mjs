/**
 * A stand-in for the `pg` driver that records statements instead of running them.
 *
 * `src/lib/db.ts` reaches its Postgres backend through exactly one line --
 * `const { default: pg } = await import("pg")` -- so resolving that bare
 * specifier to this file (see `pg-tap-hooks.mjs`) puts a tap on every statement
 * the application builds, with no instrumentation inside the application at all.
 * That matters for a "no behaviour change" gate: the thing under test must be
 * the shipped code, not a copy of it with a logging branch.
 *
 * Nothing here talks to a database. Every statement answers with zero rows,
 * which is all the SQL *text* snapshot needs.
 */

/** Every statement, in the order the application issued it. */
export const RECORDED = [];

export function reset() {
  RECORDED.length = 0;
}

function setTypeParser() {
  /* the real driver coerces int8/numeric here; nothing arrives to coerce */
}

class Pool {
  async query(sql, params = []) {
    RECORDED.push({ sql, params });
    return { rows: [] };
  }
  async end() {}
}

const pg = { types: { setTypeParser }, Pool };

export default pg;
export { Pool };
