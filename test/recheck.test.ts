// Tests for the October re-check: report feedback + audit log, hashtag lookup, session
// reminders, presence without a socket, and cross-instance delivery over LISTEN/NOTIFY.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import app from "../src/app.js";
import { db } from "../src/db.js";
import { CHANNEL, decodeEnvelope, encodeEnvelope, listenerUrl, stopListener } from "../src/fanout.js";
import { isRecentlyActive } from "../src/lib/users.js";
import { reportOutcomeText } from "../src/lib/moderation.js";
import { attachRealtime } from "../src/realtime.js";

const server = createServer(app);
const wss = attachRealtime(server);
let base = "";
let wsUrl = "";
const suffix = `r${Date.now().toString(36).slice(-5)}`;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
after(async () => {
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  await stopListener();
  server.closeAllConnections();
  server.close();
});

interface User {
  token: string;
  username: string;
  id: string;
}

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function register(name: string): Promise<User> {
  const res = await call("/auth/register", {
    method: "POST",
    body: { email: `${name}_${suffix}@example.com`, username: `${name}_${suffix}`, displayName: name, password: "quiet-password" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { token: res.data.token, username: res.data.user.username, id: res.data.user.id };
}

describe("fan-out envelopes", () => {
  it("uses the direct Neon host for LISTEN and skips its own notifications", () => {
    assert.equal(
      listenerUrl("postgresql://u:p@ep-x-pooler.c-6.us-east-2.aws.neon.tech/db?sslmode=require"),
      "postgresql://u:p@ep-x.c-6.us-east-2.aws.neon.tech/db?sslmode=require",
    );
    const payload = encodeEnvelope(["a", "a", "b"], { type: "typing" }, "me");
    assert.deepEqual(JSON.parse(payload).userIds, ["a", "b"]);
    assert.equal(decodeEnvelope(payload, "me"), undefined);
    assert.equal(decodeEnvelope(payload, "someone-else")?.event.type, "typing");
    assert.equal(decodeEnvelope("not json", "x"), undefined);
  });

  it("turns oversized events into a resync hint (NOTIFY caps payloads at 8000 bytes)", () => {
    const big = encodeEnvelope(["a"], { type: "message", body: "é".repeat(5000) }, "me");
    assert.ok(Buffer.byteLength(big) < 8000);
    assert.equal(JSON.parse(big).event.type, "resync");
  });
});

describe("presence", () => {
  it("counts a recent heartbeat as online", () => {
    const now = Date.now();
    assert.equal(isRecentlyActive(new Date(now - 30_000), now), true);
    assert.equal(isRecentlyActive(new Date(now - 10 * 60_000), now), false);
    assert.equal(isRecentlyActive(null, now), false);
  });
});

describe("re-check features", () => {
  let ada: User, bo: User, cy: User, mod: User;

  before(async () => {
    [ada, bo, cy, mod] = await Promise.all([register("ada"), register("bo"), register("cy"), register("mod")]);
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [mod.id]);
  });

  it("delivers events published by another instance to local sockets", async () => {
    const socket = new WebSocket(wsUrl);
    const events: { type: string }[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise((resolve, reject) => (socket.once("open", resolve), socket.once("error", reject)));
    socket.send(JSON.stringify({ type: "auth", token: bo.token }));
    const until = async (check: () => boolean, ms = 4000) => {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(events)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(() => events.some((e) => e.type === "ready"));
    // Simulate a different Function instance publishing through Postgres.
    const envelope = { from: "another-instance", userIds: [bo.id], event: { type: "typing", conversationId: "c", username: "x", typing: true } };
    await db.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(envelope)]);
    await until(() => events.some((e) => e.type === "typing"));
    // Events for other people aren't delivered here.
    await db.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify({ ...envelope, userIds: [cy.id], event: { type: "presence" } })]);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!events.some((e) => e.type === "presence"));
    socket.close();
  });

  it("shows someone as online from a recent heartbeat, without a socket", async () => {
    await call("/me/usage", { method: "POST", token: ada.token, body: { day: new Date().toISOString().slice(0, 10), seconds: 30 } });
    const profile = await call(`/users/${ada.username}`, { token: bo.token });
    assert.equal(profile.data.user.online, true);
    await db.query("UPDATE users SET last_seen_at = now() - interval '1 hour' WHERE id = $1", [ada.id]);
    const later = await call(`/users/${ada.username}`, { token: bo.token });
    assert.equal(later.data.user.online, false);
    assert.ok(later.data.user.lastSeenAt);
  });

  it("saves a session reminder", async () => {
    const res = await call("/me", { method: "PATCH", token: ada.token, body: { sessionReminderMinutes: 20 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.user.sessionReminderMinutes, 20);
    assert.equal((await call("/me", { method: "PATCH", token: ada.token, body: { sessionReminderMinutes: 2 } })).status, 400);
    const off = await call("/me", { method: "PATCH", token: ada.token, body: { sessionReminderMinutes: null } });
    assert.equal(off.data.user.sessionReminderMinutes, null);
  });

  it("suggests hashtags from public posts only", async () => {
    await call("/posts", { method: "POST", token: ada.token, body: { body: `#quiet${suffix} morning`, visibility: "public" } });
    await call("/posts", { method: "POST", token: ada.token, body: { body: `#quietsecret${suffix}`, visibility: "private" } });
    const res = await call(`/tags/lookup?q=%23quiet`);
    const tags = res.data.items.map((t: { tag: string }) => t.tag);
    assert.ok(tags.includes(`quiet${suffix}`));
    assert.ok(!tags.includes(`quietsecret${suffix}`));
    assert.deepEqual((await call("/tags/lookup?q=%25")).data.items, []);
  });

  it("tells reporters and authors what happened, and logs every decision", async () => {
    const post = (await call("/posts", { method: "POST", token: ada.token, body: { body: `buy my stuff ${suffix}` } })).data.post;
    const r1 = await call("/reports", { method: "POST", token: bo.token, body: { targetType: "post", postId: post.id, reason: "spam" } });
    const r2 = await call("/reports", { method: "POST", token: cy.token, body: { targetType: "post", postId: post.id, reason: "spam" } });
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);

    const resolved = await call(`/admin/reports/${r1.data.id}/resolve`, { method: "POST", token: mod.token, body: { action: "hide_post", note: "Selling" } });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.data.closed, 2);

    for (const reporter of [bo, cy]) {
      const notes = (await call("/notifications", { token: reporter.token })).data.items;
      const update = notes.find((n: { type: string }) => n.type === "report_update");
      assert.ok(update, `no report_update for ${reporter.username}`);
      assert.equal(update.body, reportOutcomeText("hide_post", "spam"));
      assert.equal(update.actor, null, "moderators stay anonymous");
    }
    const authorNotes = (await call("/notifications", { token: ada.token })).data.items;
    const notice = authorNotes.find((n: { type: string }) => n.type === "moderation");
    assert.ok(notice?.body.includes("Selling"));
    assert.equal(notice.postId, post.id);

    // Dismissed reports get an answer too.
    const user = await call("/reports", { method: "POST", token: cy.token, body: { targetType: "user", username: ada.username, reason: "impersonation" } });
    assert.equal((await call(`/admin/reports/${user.data.id}/dismiss`, { method: "POST", token: mod.token })).status, 200);
    const cyNotes = (await call("/notifications", { token: cy.token })).data.items.filter((n: { type: string }) => n.type === "report_update");
    assert.equal(cyNotes.length, 2);
    assert.ok(cyNotes[0].body.includes("didn't break our guidelines"));

    // Restoring the post tells the author.
    await call(`/admin/posts/${post.id}/unhide`, { method: "POST", token: mod.token });
    const restored = (await call("/notifications", { token: ada.token })).data.items.filter((n: { type: string }) => n.type === "moderation");
    assert.equal(restored.length, 2);

    const log = await call("/admin/actions", { token: mod.token });
    assert.equal(log.status, 200);
    const mine = log.data.items.filter((a: { target: string | null }) => a.target === ada.username).map((a: { action: string }) => a.action);
    for (const action of ["resolve_report", "hide_post", "dismiss_report", "unhide_post"]) assert.ok(mine.includes(action), `${action} not logged: ${mine}`);
    assert.equal((await call("/admin/actions", { token: ada.token })).status, 403);
  });
});
