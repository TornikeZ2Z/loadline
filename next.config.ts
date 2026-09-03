import type { NextConfig } from "next";

/**
 * `NEXT_PUBLIC_BASE_PATH` lets the app be served under a sub-path, e.g.
 * `https://ziptozip.systems/loadline`. Leave it unset for local development so
 * the app stays at `http://localhost:3000/`.
 *
 * It must be `NEXT_PUBLIC_` because client components read the same value (via
 * src/lib/basePath.ts) to prefix their `fetch` calls, and only `NEXT_PUBLIC_`
 * vars are inlined into the browser bundle.
 *
 * Next.js reads this at build time, not run time: a hosted deployment has to set
 * it before `next build`, not merely before `next start`.
 */
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");

const config: NextConfig = {
  // PGlite ships a wasm/fs bundle that must stay external to the server build.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],

  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default config;
