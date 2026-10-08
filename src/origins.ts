import { env } from "./env.js";

// Vercel preview/production URLs of the client project are always allowed.
const CLIENT_DEPLOYMENTS = /^https:\/\/asocial-media-client(-[a-z0-9-]+)?\.vercel\.app$/;
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** Browser origins allowed to call the API (CORS) and open the chat socket. Non-browser clients send no origin. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return !origin || env.clientOrigins.includes(origin) || CLIENT_DEPLOYMENTS.test(origin) || (!env.isProduction && LOCALHOST.test(origin));
}
