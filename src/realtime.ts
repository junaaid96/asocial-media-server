// Real-time chat events: new messages, read receipts, typing and presence.
//
// Primary transport: Ably (see ably.ts). publish() sends every event to the users' Ably inboxes.
// Fallback transport: this WebSocket server, for hosts without Ably configured or clients that
// can't reach Ably. Each process keeps its own sockets. Events reach sockets on other processes (other Vercel
// Function instances) through Postgres LISTEN/NOTIFY (see fanout.ts). The REST API stays the
// source of truth: clients fall back to polling if the socket can't connect, and resync
// after a reconnect.
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { accountState, verifyToken } from "./auth.js";
import { db } from "./db.js";
import { publishToUsers } from "./ably.js";
import { broadcast, configureFanout, ensureListener, listenerHealthy, stopListener } from "./fanout.js";
import { isRecentlyActive } from "./lib/users.js";
import { isAllowedOrigin } from "./origins.js";

export type ServerEvent =
  | { type: "ready"; userId: string }
  | { type: "message"; conversationId: string; message: unknown }
  | { type: "read"; conversationId: string; readerUsername: string; readAt: string }
  | { type: "typing"; conversationId: string; username: string; typing: boolean }
  | { type: "presence"; username: string; online: boolean; lastSeenAt: string | null }
  | { type: "pong" }
  | { type: "resync" }
  | { type: "error"; message: string };

interface Client {
  socket: WebSocket;
  userId: string;
  username: string;
  alive: boolean;
  typingBudget: { count: number; resetAt: number };
  seenAt: number;
}

const clients = new Map<string, Set<Client>>();

/**
 * Online if they hold a socket on this instance, or were active recently anywhere (socket
 * heartbeats and the time-tracking heartbeat both refresh last_seen_at).
 */
export function isOnline(userId: string, lastSeenAt?: Date | string | null): boolean {
  return (clients.get(userId)?.size ?? 0) > 0 || isRecentlyActive(lastSeenAt);
}

function deliverLocal(userIds: Iterable<string>, event: { type: string }) {
  const payload = JSON.stringify(event);
  for (const userId of new Set(userIds)) {
    for (const client of clients.get(userId) ?? []) {
      if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
    }
  }
}

/**
 * Sends an event to the given users: over Ably when it's configured (the primary path on Vercel),
 * and to any WebSocket fallback clients on this and every other instance.
 */
export async function publish(userIds: Iterable<string>, event: ServerEvent): Promise<void> {
  const ids = [...new Set(userIds)];
  deliverLocal(ids, event);
  await Promise.all([publishToUsers(ids, event), broadcast(ids, event)]);
}

configureFanout({
  deliver: deliverLocal,
  // The listener was down for a while: every local socket may have missed something.
  onReconnect: () => {
    for (const userId of clients.keys()) deliverLocal([userId], { type: "resync" });
  },
});

async function touch(client: Client) {
  client.seenAt = Date.now();
  await db.query("UPDATE users SET last_seen_at = now() WHERE id = $1", [client.userId]).catch(() => undefined);
}

async function conversationPartners(userId: string): Promise<string[]> {
  const rows = await db.query<{ other: string }>(
    `SELECT CASE WHEN user_a = $1 THEN user_b ELSE user_a END AS other
     FROM conversations WHERE user_a = $1 OR user_b = $1`,
    [userId],
  );
  return rows.map((r) => r.other);
}

async function announcePresence(client: Client, online: boolean) {
  const lastSeen = online ? null : new Date().toISOString();
  await touch(client);
  const partners = await conversationPartners(client.userId).catch(() => []);
  await publish(partners, { type: "presence", username: client.username, online, lastSeenAt: lastSeen });
}

// Membership is checked on every typing event; cache it briefly.
const membership = new Map<string, { other: string | null; expires: number }>();
export async function otherParticipant(conversationId: string, userId: string): Promise<string | null> {
  const key = `${conversationId}:${userId}`;
  const cached = membership.get(key);
  if (cached && cached.expires > Date.now()) return cached.other;
  const [row] = await db.query<{ other: string }>(
    `SELECT CASE WHEN user_a = $2 THEN user_b ELSE user_a END AS other
     FROM conversations WHERE id = $1 AND (user_a = $2 OR user_b = $2)`,
    [conversationId, userId],
  );
  const other = row?.other ?? null;
  membership.set(key, { other, expires: Date.now() + 60_000 });
  if (membership.size > 20_000) membership.clear();
  return other;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handleClientEvent(client: Client, raw: string) {
  let event: { type?: unknown; conversationId?: unknown; typing?: unknown };
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (event.type === "ping") {
    client.socket.send(JSON.stringify({ type: "pong" } satisfies ServerEvent));
    // Keep presence fresh for people on other instances, at most once a minute.
    if (Date.now() - client.seenAt > 60_000) await touch(client);
    return;
  }
  if (event.type === "typing" && typeof event.conversationId === "string" && UUID.test(event.conversationId)) {
    const now = Date.now();
    if (client.typingBudget.resetAt < now) client.typingBudget = { count: 0, resetAt: now + 10_000 };
    if (++client.typingBudget.count > 20) return;
    const other = await otherParticipant(event.conversationId, client.userId);
    if (!other) return;
    await publish([other], { type: "typing", conversationId: event.conversationId, username: client.username, typing: event.typing === true });
  }
}

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws" || !isAllowedOrigin(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket: WebSocket) => {
    let client: Client | undefined;
    // The token arrives in the first message rather than the URL, so it never lands in access logs.
    const authTimer = setTimeout(() => socket.close(4401, "auth timeout"), 10_000);

    socket.on("message", async (data) => {
      const raw = data.toString();
      if (client) return void handleClientEvent(client, raw).catch(() => undefined);
      try {
        const { type, token } = JSON.parse(raw) as { type?: string; token?: string };
        const userId = type === "auth" ? verifyToken(token) : undefined;
        const state = userId ? await accountState(userId) : null;
        if (!userId || !state || state.suspended) {
          socket.close(4401, "unauthorized");
          return;
        }
        const [row] = await db.query<{ username: string }>("SELECT username FROM users WHERE id = $1", [userId]);
        if (!row) return void socket.close(4401, "unauthorized");
        clearTimeout(authTimer);
        client = { socket, userId, username: row.username, alive: true, typingBudget: { count: 0, resetAt: 0 }, seenAt: 0 };
        // Hear about events published by other instances before saying we're ready.
        await ensureListener();
        const set = clients.get(userId) ?? new Set();
        const wasOffline = set.size === 0;
        set.add(client);
        clients.set(userId, set);
        socket.send(JSON.stringify({ type: "ready", userId } satisfies ServerEvent));
        if (wasOffline) await announcePresence(client, true);
        else await touch(client);
      } catch {
        socket.close(4400, "bad request");
      }
    });

    socket.on("pong", () => {
      if (client) client.alive = true;
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (!client) return;
      const set = clients.get(client.userId);
      set?.delete(client);
      if (set && set.size === 0) {
        clients.delete(client.userId);
        void announcePresence(client, false);
      }
    });
  });

  // Drop sockets that stop answering pings (sleeping laptops, dead networks).
  const heartbeat = setInterval(() => {
    // Neon drops idle sessions when it scales to zero; reconnect while anyone is listening.
    if (clients.size && !listenerHealthy()) void ensureListener();
    for (const set of clients.values()) {
      for (const client of set) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        client.socket.ping();
      }
    }
  }, 30_000);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));
  server.on("close", () => {
    clearInterval(heartbeat);
    wss.close();
    void stopListener();
  });
  return wss;
}
