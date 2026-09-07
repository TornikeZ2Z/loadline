/**
 * Base path support, for serving the app under a sub-path such as
 * `https://example.com/movermesh` rather than at a domain root.
 *
 * Next.js `basePath` already rewrites `<Link>` hrefs, router navigations and
 * static assets. What it does **not** touch is a hand-written
 * `fetch("/api/...")` in a client component: that resolves against the origin
 * and would hit `/api/...` instead of `/movermesh/api/...`, so every API call
 * would 404 in production while working perfectly in local development. Route
 * them through `api()` instead.
 *
 * `NEXT_PUBLIC_` is required for the value to be inlined into the client
 * bundle; a bare env var would read as empty in the browser.
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

/** Prefix an app-absolute path with the base path. Use for every client fetch. */
export function api(path: string): string {
  return `${BASE_PATH}${path}`;
}
