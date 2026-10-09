// The API as an http.Server: REST routes from the Express app plus WebSocket upgrades at /ws.
// Vercel serves it through api/index.ts (see vercel.json); src/server.ts listens locally.
// WebSockets on Vercel need Fluid compute. Connections close when the Function reaches its max
// duration; the client reconnects (and polls while it can't).
import { createServer } from "node:http";
import app from "./app.js";
import { attachRealtime } from "./realtime.js";

const server = createServer(app);
attachRealtime(server);

export default server;
