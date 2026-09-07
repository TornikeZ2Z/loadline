/**
 * Reading every route handler under src/app/api as text.
 *
 * Shared by two gates that ask different questions of the same list:
 * scripts/check-routes.ts ("is every handler guarded, and by the guard its
 * entry declares?") and scripts/check-redact.ts ("does every handler a
 * non-admin can reach put load rows through publicView before serialising
 * them?"). Neither question can be asked of the two library functions those
 * suites used to test in isolation -- both are about the route layer, which is
 * where a future handler will drift.
 *
 * Text, not the TypeScript API, and the reason is worth stating: the checks
 * below are about what a reviewer would see reading the top of a handler.
 * Anything clever enough to defeat a text scan -- a guard behind an indirection,
 * a response assembled somewhere else -- is also too clever to review, and
 * failing loudly on it is the correct outcome, not a false positive.
 */
import fs from "node:fs";
import path from "node:path";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface RouteHandler {
  /** Repo-relative, forward slashes: "src/app/api/loads/route.ts". */
  file: string;
  /** URL path with its dynamic segments: "/api/loads/[id]/contact". */
  route: string;
  method: HttpMethod;
  /** "POST /api/test/reset" -- the key every declaration table is written in. */
  id: string;
  /** The handler's own source text, from `export` to its closing brace. */
  body: string;
}

const METHOD_RE = new RegExp(
  String.raw`export\s+(?:const\s+(${HTTP_METHODS.join("|")})\s*=|` +
    String.raw`(?:async\s+)?function\s+(${HTTP_METHODS.join("|")})\s*\()`,
  "g",
);

/** Every route.ts under src/app/api, sorted, repo-relative with "/" separators. */
export function routeFiles(root: string): string[] {
  const base = path.join(root, "src", "app", "api");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "route.ts" || entry.name === "route.tsx") out.push(p);
    }
  };
  walk(base);
  return out.map((p) => path.relative(root, p).split(path.sep).join("/"));
}

/**
 * The handler's text, from the `export` keyword to the end of its declaration.
 *
 * Balanced over (), [] and {}, skipping string, template and comment contents so
 * a brace inside `"}"` or a regex-looking comment cannot end the scan early.
 * The declaration is over when depth returns to zero AFTER a body has opened --
 * the `{` test is what stops `export function GET() {` ending the scan on its
 * own empty parameter list.
 */
function declarationAt(src: string, start: number): string {
  let i = start;
  let depth = 0;
  let sawBody = false;

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "/" && next === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) break;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === c) break;
        i++;
      }
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      depth++;
      if (c === "{") sawBody = true;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (sawBody && depth <= 0) return src.slice(start, i + 1);
    }
    i++;
  }
  return src.slice(start);
}

/** "src/app/api/loads/[id]/contact/route.ts" -> "/api/loads/[id]/contact". */
export function routeOf(file: string): string {
  return "/" + file.replace(/^src\/app\//, "").replace(/\/route\.tsx?$/, "");
}

export function routeHandlers(root: string): RouteHandler[] {
  const out: RouteHandler[] = [];
  for (const file of routeFiles(root)) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const route = routeOf(file);
    METHOD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = METHOD_RE.exec(src))) {
      const method = (m[1] ?? m[2]) as HttpMethod;
      out.push({
        file,
        route,
        method,
        id: `${method} ${route}`,
        body: declarationAt(src, m.index),
      });
    }
  }
  return out;
}

// --- what a handler does about authorization ---------------------------------

/**
 * A short word for the gate a handler actually applies, in the vocabulary the
 * declaration tables are written in.
 *
 *   write:admin   requireWriteRole("admin")  -- a mutation of shared state
 *   role:admin    requireRole("admin")       -- reading an admin surface
 *   posting       requirePosting()           -- the users.can_post capability
 *   user          requireUser(), or getCurrentUser() with its own 401
 *   cron-secret   requireCronSecret(req)
 *   webhook       the Meta verify token / the X-Hub-Signature-256 HMAC
 *   public        none of the above; anybody may call it
 */
export function guardOf(body: string): string {
  const roles = (fn: string): string | null => {
    const m = new RegExp(String.raw`\b${fn}\(([^)]*)\)`).exec(body);
    if (!m) return null;
    const names = [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
    return names.join(",");
  };

  const write = roles("requireWriteRole");
  if (write !== null) return `write:${write}`;
  const read = roles("requireRole");
  if (read !== null) return `role:${read}`;
  if (/\brequirePosting\(/.test(body)) return "posting";
  if (/\brequireUser\(/.test(body)) return "user";
  // The contact reveal reads the session by hand so it can say "Sign in to see
  // the contact" instead of requireUser()'s generic line -- a 401 it throws
  // itself is the same gate, and this recognises it as one.
  if (/\bgetCurrentUser\(/.test(body) && /HttpError\(401/.test(body)) return "user";
  if (/\brequireCronSecret\(/.test(body)) return "cron-secret";
  if (/WHATSAPP_VERIFY_TOKEN|verifySignature\(/.test(body)) return "webhook";
  return "public";
}

/** True for a guard that only an admin -- never a driver, poster or stranger -- passes. */
export function isAdminOnly(guard: string): boolean {
  return guard === "role:admin" || guard === "write:admin";
}

/** True for a guard that no person holds an account for: cron and the webhook. */
export function isMachineOnly(guard: string): boolean {
  return guard === "cron-secret" || guard === "webhook";
}
