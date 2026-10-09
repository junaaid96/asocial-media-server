// Vercel entrypoint. Vercel's Express preset serves src/index.ts as a plain request handler,
// which can't accept WebSocket upgrades, so the deployment uses this Function instead: it
// exports the http.Server (REST under /api plus the chat socket at /ws), as in Vercel's
// WebSocket docs. vercel.json rewrites every path here; req.url keeps the original path.
import server from "../src/index.js";

export default server;
