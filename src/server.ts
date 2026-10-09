// Long-running server for local development: the REST API plus the real-time chat socket at /ws.
import server from "./index.js";

const port = Number(process.env.PORT ?? 5000);
server.listen(port, () => console.log(`aSocial API listening on http://localhost:${port} (chat socket at /ws)`));
