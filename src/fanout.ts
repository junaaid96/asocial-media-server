// Cross-instance delivery for real-time events.
//
// On Vercel every WebSocket is pinned to one Function instance, and the REST request that
// creates a message may run on a different one. Each instance that holds sockets LISTENs on a
// Postgres channel; publishers NOTIFY it. No extra service: it's the database we already have.
//
// Postgres LISTEN needs a session, so the listener uses a direct (non-pooled) connection.
// Neon closes idle sessions when the compute scales to zero, so the listener reconnects on
// demand and tells local sockets to resync, and clients keep a slow safety poll as well.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { db } from "./db.js";
import { env } from "./env.js";

export const CHANNEL = "asocial_realtime";
// Postgres caps NOTIFY payloads at 8000 bytes; larger events become a "resync" hint.
const MAX_PAYLOAD = 7500;
const instanceId: string = randomUUID();

export interface Envelope {
  from: string;
  userIds: string[];
  event: { type: string } & Record<string, unknown>;
}

type Deliver = (userIds: string[], event: Envelope["event"]) => void;

let deliver: Deliver | undefined;
let onReconnect: (() => void) | undefined;
let listener: pg.Client | undefined;
let connecting: Promise<void> | undefined;
let everConnected = false;

export function fanoutEnabled() {
  return process.env.REALTIME_FANOUT !== "off";
}

/** The Neon pooler (PgBouncer, transaction mode) can't hold LISTEN; use the direct host. */
export function listenerUrl(url = env.databaseUrl) {
  return process.env.DATABASE_URL_DIRECT || url.replace("-pooler.", ".");
}

export function encodeEnvelope(userIds: Iterable<string>, event: Envelope["event"], from = instanceId): string {
  const ids = [...new Set(userIds)];
  const payload = JSON.stringify({ from, userIds: ids, event } satisfies Envelope);
  if (Buffer.byteLength(payload) <= MAX_PAYLOAD) return payload;
  return JSON.stringify({ from, userIds: ids, event: { type: "resync" } } satisfies Envelope);
}

/** Parses a notification; ignores our own (already delivered locally) and malformed ones. */
export function decodeEnvelope(payload: string | undefined, self = instanceId): Envelope | undefined {
  if (!payload) return undefined;
  try {
    const envelope = JSON.parse(payload) as Envelope;
    if (envelope.from === self || !Array.isArray(envelope.userIds) || typeof envelope.event?.type !== "string") return undefined;
    return envelope;
  } catch {
    return undefined;
  }
}

export function configureFanout(handlers: { deliver: Deliver; onReconnect: () => void }) {
  deliver = handlers.deliver;
  onReconnect = handlers.onReconnect;
}

/** Starts (or restarts) the LISTEN session. Safe to call often; it's a no-op while healthy. */
export function ensureListener(): Promise<void> {
  if (!fanoutEnabled() || !deliver) return Promise.resolve();
  if (listener) return Promise.resolve();
  connecting ??= (async () => {
    const client = new pg.Client({ connectionString: listenerUrl(), keepAlive: true });
    const drop = () => {
      if (listener === client) listener = undefined;
      client.end().catch(() => undefined);
    };
    client.on("error", drop);
    client.on("end", drop);
    client.on("notification", (message) => {
      const envelope = decodeEnvelope(message.payload);
      if (envelope) deliver?.(envelope.userIds, envelope.event);
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      listener = client;
      // Anything sent while we weren't listening was missed; ask local sockets to catch up.
      if (everConnected) onReconnect?.();
      everConnected = true;
    } catch (error) {
      drop();
      console.warn("realtime listener unavailable:", (error as Error).message);
    }
  })().finally(() => {
    connecting = undefined;
  });
  return connecting;
}

/** Sends an event to sockets held by other instances. Never throws. */
export async function broadcast(userIds: Iterable<string>, event: Envelope["event"]) {
  if (!fanoutEnabled()) return;
  await db.query("SELECT pg_notify($1, $2)", [CHANNEL, encodeEnvelope(userIds, event)]).catch((error) => {
    console.warn("realtime notify failed:", (error as Error).message);
  });
}

export async function stopListener() {
  const client = listener;
  listener = undefined;
  await client?.end().catch(() => undefined);
}

export function listenerHealthy() {
  return !!listener;
}
