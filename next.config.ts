import type { NextConfig } from "next";

const config: NextConfig = {
  // PGlite ships a wasm/fs bundle that must stay external to the server build.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default config;
