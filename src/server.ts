// Long-running server: the REST API plus the real-time chat socket at /ws.
import { createServer } from "node:http";
import app from "./app.js";
import { attachRealtime } from "./realtime.js";

const port = Number(process.env.PORT ?? 5000);
const server = createServer(app);
attachRealtime(server);
server.listen(port, () => console.log(`aSocial API listening on http://localhost:${port} (chat socket at /ws)`));
