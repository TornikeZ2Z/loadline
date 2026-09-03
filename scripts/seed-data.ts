/**
 * Re-export so `npm run seed` and the in-app test console share one corpus.
 * The data itself lives under src/ because the API routes import it too.
 */
export { GROUPS, MESSAGES, type SeedMessage } from "../src/lib/demo/sample-messages";
