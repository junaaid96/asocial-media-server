import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { optionalAuth } from "./auth.js";
import { env } from "./env.js";
import { HttpError } from "./lib/http.js";
import { router as authRouter } from "./routes/auth.js";
import { router as lettersRouter } from "./routes/letters.js";
import { router as notificationsRouter } from "./routes/notifications.js";
import { router as postsRouter } from "./routes/posts.js";
import { router as searchRouter } from "./routes/search.js";
import { router as uploadsRouter } from "./routes/uploads.js";
import { router as usersRouter } from "./routes/users.js";

const app = express();

app.set("trust proxy", true);
app.disable("x-powered-by");
// Security headers for a JSON API (the client is served from its own origin).
app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });
  next();
});

// Vercel preview/production URLs of the client project are always allowed.
const CLIENT_DEPLOYMENTS = /^https:\/\/asocial-media-client(-[a-z0-9-]+)?\.vercel\.app$/;
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(
  cors({
    origin(origin, callback) {
      const allowed =
        !origin || env.clientOrigins.includes(origin) || CLIENT_DEPLOYMENTS.test(origin) || (!env.isProduction && LOCALHOST.test(origin));
      callback(null, allowed);
    },
    maxAge: 86_400,
  }),
);
app.use(express.json({ limit: "100kb" }));
app.use(optionalAuth);

app.get(["/", "/api"], (_req, res) => {
  res.json({ name: "aSocial API", status: "calm", docs: "https://github.com/junaaid96/asocial-media-server" });
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use("/api/auth", authRouter);
app.use("/api", usersRouter, postsRouter, lettersRouter, notificationsRouter, searchRouter, uploadsRouter);

app.use((_req, _res, next) => next(new HttpError(404, "Not found")));

const PG_ERRORS: Record<string, [number, string]> = {
  "23505": [409, "That already exists"],
  "23503": [404, "Something you referenced no longer exists"],
  "23514": [400, "Some of that input isn't allowed"],
  "22P02": [400, "Malformed input"],
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message, details: error.details });
  }
  const err = error as { code?: string; type?: string; status?: number };
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That file is too large (max 4 MB)" });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON" });
  if (err.code && PG_ERRORS[err.code]) {
    const [status, message] = PG_ERRORS[err.code]!;
    return res.status(status).json({ error: message });
  }
  console.error(error);
  res.status(500).json({ error: "Something went wrong on our side. Please try again." });
});

export default app;
