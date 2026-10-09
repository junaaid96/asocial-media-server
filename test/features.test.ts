// End-to-end tests for privacy, rich text, tags, comment reactions, reports, admin,
// time tracking and real-time chat. Needs a disposable, migrated DATABASE_URL.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import app from "../src/app.js";
import { db } from "../src/db.js";
import { attachRealtime } from "../src/realtime.js";

const server = createServer(app);
const wss = attachRealtime(server);
let base = "";
let wsUrl = "";
const suffix = Date.now().toString(36).slice(-6);

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
  wsUrl = `ws://127.0.0.1:${port}/ws`;
});
after(() => {
  for (const socket of wss.clients) socket.terminate();
  wss.close();
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

/** Opens an authenticated socket and collects events. */
async function connect(user: User) {
  const socket = new WebSocket(wsUrl);
  const events: Record<string, unknown>[] = [];
  const waiters: { match: (e: Record<string, unknown>) => boolean; resolve: (e: Record<string, unknown>) => void }[] = [];
  socket.on("message", (data) => {
    const event = JSON.parse(data.toString());
    events.push(event);
    for (const w of [...waiters]) if (w.match(event)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(event));
  });
  await new Promise((resolve, reject) => (socket.once("open", resolve), socket.once("error", reject)));
  const waitFor = (match: (e: Record<string, unknown>) => boolean, ms = 3000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const found = events.find(match);
      if (found) return resolve(found);
      const timer = setTimeout(() => reject(new Error(`timed out; got ${JSON.stringify(events)}`)), ms);
      waiters.push({ match, resolve: (e) => (clearTimeout(timer), resolve(e)) });
    });
  socket.send(JSON.stringify({ type: "auth", token: user.token }));
  await waitFor((e) => e.type === "ready");
  return { socket, events, waitFor, send: (e: unknown) => socket.send(JSON.stringify(e)) };
}

describe("aSocial features", () => {
  let ada: User, bo: User, cy: User, mod: User;

  before(async () => {
    [ada, bo, cy, mod] = await Promise.all([register("ada"), register("bo"), register("cy"), register("mod")]);
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [mod.id]);
    // bo follows ada; cy follows no one.
    await call(`/users/${ada.username}/follow`, { method: "POST", token: bo.token });
  });

  it("enforces post privacy in feeds, profiles, single posts and interactions", async () => {
    const make = async (visibility: string, body: string) =>
      (await call("/posts", { method: "POST", token: ada.token, body: { body, visibility } })).data.post;
    const pub = await make("public", `public words ${suffix}`);
    const fol = await make("followers", `followers words ${suffix}`);
    const priv = await make("private", `private words ${suffix}`);
    assert.equal(fol.visibility, "followers");

    const ids = async (user?: User) =>
      ((await call(`/users/${ada.username}/posts`, { token: user?.token })).data.items as { id: string }[]).map((p) => p.id);
    assert.deepEqual(new Set(await ids(ada)), new Set([pub.id, fol.id, priv.id]));
    assert.deepEqual(new Set(await ids(bo)), new Set([pub.id, fol.id]));
    assert.deepEqual(await ids(cy), [pub.id]);
    assert.deepEqual(await ids(), [pub.id]);

    const latest = (await call("/posts?limit=30", { token: cy.token })).data.items.map((p: { id: string }) => p.id);
    assert.ok(latest.includes(pub.id) && !latest.includes(fol.id) && !latest.includes(priv.id));

    assert.equal((await call(`/posts/${fol.id}`, { token: bo.token })).status, 200);
    assert.equal((await call(`/posts/${fol.id}`, { token: cy.token })).status, 404);
    assert.equal((await call(`/posts/${priv.id}`, { token: bo.token })).status, 404);
    assert.equal((await call(`/posts/${priv.id}/reaction`, { method: "PUT", token: bo.token, body: { kind: "hug" } })).status, 404);
    assert.equal((await call(`/posts/${fol.id}/comments`, { method: "POST", token: cy.token, body: { body: "hi" } })).status, 404);
    assert.equal((await call(`/posts/${priv.id}/comments`, { token: bo.token })).status, 404);
    assert.equal((await call(`/search?q=private ${suffix}`, { token: cy.token })).data.posts.length, 0);

    // Profile post counts respect privacy too.
    assert.equal((await call(`/users/${ada.username}`, { token: cy.token })).data.stats.posts, 1);

    // Changing visibility on edit doesn't mark the post as edited.
    const opened = await call(`/posts/${priv.id}`, { method: "PATCH", token: ada.token, body: { visibility: "public" } });
    assert.equal(opened.data.post.visibility, "public");
    assert.equal(opened.data.post.editedAt, null);
    assert.equal((await call(`/posts/${priv.id}`, { token: cy.token })).status, 200);
  });

  it("sanitizes rich text, links hashtags and notifies mentions", async () => {
    const created = await call("/posts", {
      method: "POST",
      token: bo.token,
      body: { body: `**Rain** <script>x</script>[bad](javascript:alert(1)) with @${ada.username} and @${cy.username} #RainyDays #tea` },
    });
    assert.equal(created.status, 201);
    const post = created.data.post;
    assert.ok(!post.body.includes("<script>"));
    assert.ok(!post.body.includes("javascript:"));
    assert.ok(post.body.startsWith("**Rain**"));

    const tagged = await call("/posts?tag=rainydays");
    assert.deepEqual(tagged.data.items.map((p: { id: string }) => p.id), [post.id]);
    assert.equal((await call("/posts?tag=%23Tea")).data.items[0].id, post.id);
    assert.ok((await call("/tags/trending")).data.items.some((t: { tag: string }) => t.tag === "rainydays"));

    const mention = (await call("/notifications", { token: ada.token })).data.items.find((n: { type: string }) => n.type === "mention");
    assert.equal(mention.postId, post.id);
    assert.equal(mention.actor.username, bo.username);
    assert.ok(mention.postExcerpt.startsWith("Rain"), mention.postExcerpt);

    // Mentions in a followers-only post only reach people who can see it.
    const before = (await call("/notifications", { token: cy.token })).data.items.filter((n: { type: string }) => n.type === "mention").length;
    await call("/posts", { method: "POST", token: bo.token, body: { body: `secret for @${cy.username}`, visibility: "followers" } });
    const afterCount = (await call("/notifications", { token: cy.token })).data.items.filter((n: { type: string }) => n.type === "mention").length;
    assert.equal(afterCount, before);

    // Editing only notifies newly added mentions.
    await call(`/posts/${post.id}`, { method: "PATCH", token: bo.token, body: { body: `${post.body} again @${ada.username}` } });
    const mentions = (await call("/notifications", { token: ada.token })).data.items.filter((n: { type: string }) => n.type === "mention");
    assert.equal(mentions.length, 1);

    // Tags follow edits.
    await call(`/posts/${post.id}`, { method: "PATCH", token: bo.token, body: { body: "no tags now" } });
    assert.equal((await call("/posts?tag=rainydays")).data.items.length, 0);

    const lookup = await call(`/users/lookup?q=${ada.username.slice(0, 4)}`, { token: bo.token });
    assert.equal(lookup.data.items[0].username, ada.username);
  });

  it("shows prompt questions and filters answers by prompt", async () => {
    const answer = (await call("/posts", { method: "POST", token: cy.token, body: { body: "my answer", answersPrompt: true } })).data.post;
    assert.ok(answer.prompt.text.length > 5);
    assert.equal(answer.prompt.date, answer.promptDate);
    const list = await call(`/posts?promptDate=${answer.promptDate}`);
    assert.ok(list.data.items.every((p: { promptDate: string }) => p.promptDate === answer.promptDate));
    assert.ok(list.data.items.some((p: { id: string }) => p.id === answer.id));
    const prompt = await call(`/prompts/${answer.promptDate}`);
    assert.equal(prompt.data.text, answer.prompt.text);
    assert.ok(prompt.data.answers >= 1);
    assert.equal((await call("/prompts/2999-01-01")).status, 404);
    assert.equal((await call("/posts?promptDate=nope")).status, 400);
  });

  it("reacts to replies with quiet counts", async () => {
    const post = (await call("/posts", { method: "POST", token: ada.token, body: { body: "reply to me" } })).data.post;
    const comment = (await call(`/posts/${post.id}/comments`, { method: "POST", token: bo.token, body: { body: `_thanks_ @${ada.username}` } })).data.comment;
    const reacted = await call(`/comments/${comment.id}/reaction`, { method: "PUT", token: ada.token, body: { kind: "insight" } });
    assert.equal(reacted.status, 200);
    assert.equal(reacted.data.comment.myReaction, "insight");
    assert.equal(reacted.data.comment.reactionCounts, null, "quiet counts hide totals from non-authors");
    await call(`/comments/${comment.id}/reaction`, { method: "PUT", token: cy.token, body: { kind: "hug" } });
    const asAuthor = (await call(`/posts/${post.id}/comments`, { token: bo.token })).data.items[0];
    assert.deepEqual(asAuthor.reactionCounts, { insight: 1, hug: 1 });
    assert.equal(asAuthor.reactionTotal, 2);
    const notes = (await call("/notifications", { token: bo.token })).data.items;
    assert.ok(notes.some((n: { type: string; reaction: string }) => n.type === "comment_reaction" && n.reaction === "insight"));
    const removed = await call(`/comments/${comment.id}/reaction`, { method: "DELETE", token: ada.token });
    assert.equal(removed.data.comment.myReaction, null);

    // Post totals: sum across reaction kinds, for the author.
    await call(`/posts/${post.id}/reaction`, { method: "PUT", token: bo.token, body: { kind: "hug" } });
    await call(`/posts/${post.id}/reaction`, { method: "PUT", token: cy.token, body: { kind: "felt" } });
    const own = (await call(`/posts/${post.id}`, { token: ada.token })).data.post;
    assert.equal(own.reactionTotal, 2);
    assert.deepEqual(own.reactionCounts, { hug: 1, felt: 1 });
  });

  it("tracks time spent per day with a limit", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const first = await call("/me/usage", { method: "POST", token: cy.token, body: { day, seconds: 60 } });
    assert.equal(first.data.today, 60);
    const throttled = await call("/me/usage", { method: "POST", token: cy.token, body: { day, seconds: 60 } });
    assert.equal(throttled.data.counted, false);
    assert.equal((await call("/me/usage", { method: "POST", token: cy.token, body: { day: "2001-01-01", seconds: 60 } })).status, 400);
    assert.equal((await call("/me/usage", { method: "POST", token: cy.token, body: { day, seconds: 9999 } })).status, 400);
    await call("/me", { method: "PATCH", token: cy.token, body: { dailyLimitMinutes: 30 } });
    const usage = await call("/me/usage", { token: cy.token });
    assert.equal(usage.data.dailyLimitMinutes, 30);
    assert.deepEqual(usage.data.days, [{ day, seconds: 60 }]);
    assert.equal((await call("/auth/me", { token: cy.token })).data.user.dailyLimitMinutes, 30);
  });

  it("chats in real time with typing, presence, read receipts and history", async () => {
    const adaSocket = await connect(ada);
    const opened = await call("/conversations", { method: "POST", token: ada.token, body: { username: bo.username } });
    assert.equal(opened.status, 201);
    const conversationId = opened.data.conversation.id;
    assert.equal(opened.data.conversation.other.online, false);
    // Opening it again returns the same conversation.
    assert.equal((await call("/conversations", { method: "POST", token: bo.token, body: { username: ada.username } })).data.conversation.id, conversationId);

    const boSocket = await connect(bo);
    const presence = await adaSocket.waitFor((e) => e.type === "presence" && e.username === bo.username);
    assert.equal(presence.online, true);
    assert.equal((await call(`/conversations/${conversationId}`, { token: ada.token })).data.conversation.other.online, true);

    adaSocket.send({ type: "typing", conversationId, typing: true });
    const typing = await boSocket.waitFor((e) => e.type === "typing");
    assert.equal(typing.username, ada.username);
    // Typing into someone else's conversation goes nowhere.
    cy && (await connect(cy)).send({ type: "typing", conversationId, typing: true });

    const sent = await call(`/conversations/${conversationId}/messages`, { method: "POST", token: ada.token, body: { body: "hello **bo**", clientId: "c1" } });
    assert.equal(sent.status, 201);
    const pushed = await boSocket.waitFor((e) => e.type === "message");
    assert.equal((pushed.message as { body: string }).body, "hello **bo**");
    // A retried send with the same clientId doesn't duplicate.
    const retry = await call(`/conversations/${conversationId}/messages`, { method: "POST", token: ada.token, body: { body: "hello **bo**", clientId: "c1" } });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.message.id, sent.data.message.id);

    const list = await call("/conversations", { token: bo.token });
    assert.equal(list.data.items[0].unread, 1);
    assert.equal(list.data.items[0].lastMessage.body, "hello **bo**");
    assert.equal((await call("/notifications/summary", { token: bo.token })).data.messages, 1);

    await call(`/conversations/${conversationId}/read`, { method: "POST", token: bo.token });
    const read = await adaSocket.waitFor((e) => e.type === "read");
    assert.equal(read.readerUsername, bo.username);
    assert.equal((await call("/messages/unread", { token: bo.token })).data.unread, 0);

    for (let i = 0; i < 5; i++) {
      await call(`/conversations/${conversationId}/messages`, { method: "POST", token: bo.token, body: { body: `msg ${i}` } });
    }
    const page1 = await call(`/conversations/${conversationId}/messages?limit=3`, { token: ada.token });
    assert.deepEqual(page1.data.items.map((m: { body: string }) => m.body), ["msg 2", "msg 3", "msg 4"]);
    assert.equal(page1.data.hasMore, true);
    const page2 = await call(`/conversations/${conversationId}/messages?limit=10&before=${page1.data.items[0].id}`, { token: ada.token });
    assert.deepEqual(page2.data.items.map((m: { body: string }) => m.body), ["hello **bo**", "msg 0", "msg 1"]);
    const since = await call(`/conversations/${conversationId}/messages?after=${page1.data.items[1].id}`, { token: ada.token });
    assert.deepEqual(since.data.items.map((m: { body: string }) => m.body), ["msg 4"]);

    // Outsiders can't read or write.
    assert.equal((await call(`/conversations/${conversationId}/messages`, { token: cy.token })).status, 404);
    assert.equal((await call(`/conversations/${conversationId}/messages`, { method: "POST", token: cy.token, body: { body: "hi" } })).status, 404);

    // Recipient settings are respected for new conversations.
    await call("/me", { method: "PATCH", token: cy.token, body: { lettersFrom: "nobody" } });
    assert.equal((await call("/conversations", { method: "POST", token: ada.token, body: { username: cy.username } })).status, 403);

    boSocket.socket.close();
    const offline = await adaSocket.waitFor((e) => e.type === "presence" && e.online === false);
    assert.ok(offline.lastSeenAt);
    adaSocket.socket.close();
  });

  it("rejects unauthenticated sockets", async () => {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve) => socket.once("open", resolve));
    socket.send(JSON.stringify({ type: "auth", token: "nope" }));
    const code = await new Promise((resolve) => socket.once("close", resolve));
    assert.equal(code, 4401);
  });

  it("files reports and lets admins moderate", async () => {
    const post = (await call("/posts", { method: "POST", token: cy.token, body: { body: "buy cheap stuff #spam" } })).data.post;
    const report = await call("/reports", { method: "POST", token: ada.token, body: { targetType: "post", postId: post.id, reason: "spam" } });
    assert.equal(report.status, 201);
    assert.equal((await call("/reports", { method: "POST", token: ada.token, body: { targetType: "post", postId: post.id, reason: "spam" } })).status, 409);
    assert.equal((await call("/reports", { method: "POST", token: cy.token, body: { targetType: "post", postId: post.id, reason: "spam" } })).status, 400);
    assert.equal((await call("/reports", { method: "POST", token: ada.token, body: { targetType: "user", username: cy.username, reason: "other" } })).status, 400);
    const userReport = await call("/reports", { method: "POST", token: bo.token, body: { targetType: "user", username: cy.username, reason: "harassment", details: "rude" } });
    assert.equal(userReport.status, 201);

    // Messages can be reported by their recipient only.
    const conv = (await call("/conversations", { method: "POST", token: bo.token, body: { username: mod.username } })).data.conversation;
    const msg = (await call(`/conversations/${conv.id}/messages`, { method: "POST", token: bo.token, body: { body: "unkind words" } })).data.message;
    assert.equal((await call("/reports", { method: "POST", token: ada.token, body: { targetType: "message", messageId: msg.id, reason: "harassment" } })).status, 404);
    const messageReport = await call("/reports", { method: "POST", token: mod.token, body: { targetType: "message", messageId: msg.id, reason: "harassment" } });
    assert.equal(messageReport.status, 201);

    // Only admins reach the admin API.
    assert.equal((await call("/admin/stats", { token: ada.token })).status, 403);
    assert.equal((await call("/admin/stats")).status, 401);
    const stats = await call("/admin/stats", { token: mod.token });
    assert.equal(stats.status, 200);
    assert.ok(stats.data.totals.open_reports >= 3);
    assert.equal(stats.data.series.length, 14);

    const queue = (await call("/admin/reports", { token: mod.token })).data.items;
    const postReport = queue.find((r: { id: string }) => r.id === report.data.id);
    assert.equal(postReport.target.postId, post.id);
    assert.equal(postReport.excerpt, "buy cheap stuff #spam");

    // Resolve by hiding the post: it disappears for everyone but its author.
    const resolved = await call(`/admin/reports/${report.data.id}/resolve`, { method: "POST", token: mod.token, body: { action: "hide_post", note: "spam" } });
    assert.equal(resolved.status, 200);
    assert.equal((await call(`/posts/${post.id}`, { token: ada.token })).status, 404);
    const own = await call(`/posts/${post.id}`, { token: cy.token });
    assert.equal(own.data.post.hiddenByModerators, true);
    assert.equal((await call(`/admin/reports/${report.data.id}/dismiss`, { method: "POST", token: mod.token })).status, 409);
    assert.ok((await call("/admin/posts?status=hidden", { token: mod.token })).data.items.some((p: { id: string }) => p.id === post.id));
    await call(`/admin/posts/${post.id}/unhide`, { method: "POST", token: mod.token });
    assert.equal((await call(`/posts/${post.id}`, { token: ada.token })).status, 200);

    // Suspend the reported user: they can't sign in or act, and their content disappears.
    const userReportId = userReport.data.id;
    await call(`/admin/reports/${userReportId}/resolve`, { method: "POST", token: mod.token, body: { action: "suspend_user" } });
    assert.equal((await call("/auth/login", { method: "POST", body: { identifier: cy.username, password: "quiet-password" } })).status, 403);
    assert.equal((await call("/posts", { method: "POST", token: cy.token, body: { body: "still here?" } })).status, 403);
    assert.equal((await call("/auth/me", { token: cy.token })).data.user.suspended, true);
    assert.equal((await call(`/users/${cy.username}`, { token: ada.token })).status, 404);
    assert.equal((await call(`/posts/${post.id}`, { token: ada.token })).status, 404);
    const suspendedList = (await call("/admin/users?status=suspended", { token: mod.token })).data.items;
    assert.ok(suspendedList.some((u: { username: string }) => u.username === cy.username));
    assert.equal((await call(`/admin/users/${mod.id}/suspend`, { method: "POST", token: mod.token, body: {} })).status, 400);

    await call(`/admin/users/${cy.id}/unsuspend`, { method: "POST", token: mod.token });
    assert.equal((await call("/auth/login", { method: "POST", body: { identifier: cy.username, password: "quiet-password" } })).status, 200);

    const dismissed = (await call("/admin/reports?status=open", { token: mod.token })).data.items.find((r: { id: string }) => r.id === messageReport.data.id);
    assert.equal((await call(`/admin/reports/${dismissed.id}/dismiss`, { method: "POST", token: mod.token, body: { note: "context" } })).status, 200);
    // Other test files share the database, so look the report up by id rather than position.
    const dismissedList = (await call("/admin/reports?status=dismissed", { token: mod.token })).data.items;
    assert.equal(dismissedList.find((r: { id: string }) => r.id === dismissed.id).resolvedBy, mod.username);
  });
});
