// Vercel entrypoint. Exporting an http.Server (rather than the bare Express app) lets the
// same Function serve REST requests and WebSocket upgrades at /ws. WebSockets on Vercel need
// Fluid compute, which is on by default for new projects. Connections close when the Function
// reaches its max duration; the client reconnects (and polls while it can't).
import { createServer } from "node:http";
import app from "./app.js";
import { attachRealtime } from "./realtime.js";

const server = createServer(app);
attachRealtime(server);

export default server;
