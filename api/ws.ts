// WebSocket entrypoint for Vercel. Vercel's Express preset serves src/index.ts as a plain
// request handler, so socket upgrades get a dedicated Function at /api/ws that exports the
// http.Server (REST + /ws hub) directly, as in Vercel's WebSocket docs.
import server from "../src/index.js";

export default server;
