// End-to-end API tests. Needs DATABASE_URL pointing at a disposable database
// that has been migrated (npm run db:migrate).
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import app from "../src/app.js";
import { db } from "../src/db.js";

let base = "";
const server = app.listen(0);
const suffix = Date.now().toString(36).slice(-6);

before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(() => server.close());

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(base + path, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function register(name: string) {
  const res = await call("/auth/register", {
    method: "POST",
    body: { email: `${name}_${suffix}@example.com`, username: `${name}_${suffix}`, displayName: name, password: "quiet-password" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { token: res.data.token as string, username: res.data.user.username as string };
}

describe("aSocial API", () => {
  let ada: { token: string; username: string };
  let bo: { token: string; username: string };
  let postId = "";
  let anonId = "";

  it("registers and logs in", async () => {
    ada = await register("ada");
    bo = await register("bo");
    const dup = await call("/auth/register", {
      method: "POST",
      body: { email: `x${suffix}@example.com`, username: ada.username, displayName: "x", password: "quiet-password" },
    });
    assert.equal(dup.status, 409);
    const login = await call("/auth/login", { method: "POST", body: { identifier: ada.username.toUpperCase(), password: "quiet-password" } });
    assert.equal(login.status, 200);
    const bad = await call("/auth/login", { method: "POST", body: { identifier: ada.username, password: "nope" } });
    assert.equal(bad.status, 401);
    const me = await call("/auth/me", { token: ada.token });
    assert.equal(me.data.user.username, ada.username);
    assert.equal(me.data.user.battery, "full");
  });

  it("validates input", async () => {
    const res = await call("/auth/register", { method: "POST", body: { email: "nope", username: "A!", displayName: "", password: "1" } });
    assert.equal(res.status, 400);
    assert.ok(res.data.error);
    assert.equal((await call("/posts", { method: "POST", body: { body: "hi" } })).status, 401);
    assert.equal((await call("/posts/not-a-uuid")).status, 404);
  });

  it("creates posts, hides counts and anonymity", async () => {
    const created = await call("/posts", {
      method: "POST",
      token: ada.token,
      body: { body: "Rainy evenings and tea", mood: "calm", answersPrompt: true },
    });
    assert.equal(created.status, 201);
    postId = created.data.post.id;
    assert.equal(created.data.post.isMine, true);
    assert.ok(created.data.post.promptDate);

    const anon = await call("/posts", { method: "POST", token: ada.token, body: { body: "A secret worry", isAnonymous: true, mood: "anxious" } });
    anonId = anon.data.post.id;

    const react = await call(`/posts/${postId}/reaction`, { method: "PUT", token: bo.token, body: { kind: "hug" } });
    assert.equal(react.status, 200);
    assert.equal(react.data.post.myReaction, "hug");
    assert.equal(react.data.post.reactionCounts, null, "counts are hidden from non-authors");

    const own = await call(`/posts/${postId}`, { token: ada.token });
    assert.deepEqual(own.data.post.reactionCounts, { hug: 1 });

    const anonForBo = await call(`/posts/${anonId}`, { token: bo.token });
    assert.equal(anonForBo.data.post.author, null);
    const profilePosts = await call(`/users/${ada.username}/posts`, { token: bo.token });
    assert.ok(profilePosts.data.items.every((p: { id: string }) => p.id !== anonId));
    const ownProfilePosts = await call(`/users/${ada.username}/posts`, { token: ada.token });
    assert.ok(ownProfilePosts.data.items.some((p: { id: string }) => p.id === anonId));
  });

  it("paginates the feed with cursors", async () => {
    for (let i = 0; i < 3; i++) {
      await call("/posts", { method: "POST", token: bo.token, body: { body: `note ${i}`, mood: "curious" } });
    }
    const first = await call("/posts?limit=2");
    assert.equal(first.data.items.length, 2);
    assert.ok(first.data.nextCursor);
    const second = await call(`/posts?limit=2&cursor=${first.data.nextCursor}`);
    assert.equal(second.data.items.length, 2);
    assert.notEqual(second.data.items[0].id, first.data.items[1].id);
    const curious = await call("/posts?mood=curious&limit=30");
    assert.ok(curious.data.items.every((p: { mood: string }) => p.mood === "curious"));
    const prompt = await call("/posts?feed=prompt");
    assert.ok(prompt.data.items.some((p: { id: string }) => p.id === postId));
    assert.equal((await call("/prompt")).status, 200);
    assert.equal((await call("/posts?feed=following")).status, 401);
  });

  it("follows, suggests and notifies", async () => {
    const suggested = await call("/users/suggested", { token: bo.token });
    assert.ok(suggested.data.items.some((u: { username: string }) => u.username === ada.username));
    assert.equal((await call(`/users/${ada.username}/follow`, { method: "POST", token: bo.token })).status, 200);
    const following = await call("/posts?feed=following", { token: bo.token });
    assert.ok(following.data.items.some((p: { id: string }) => p.id === postId));
    assert.ok(following.data.items.every((p: { id: string }) => p.id !== anonId), "anonymous posts don't leak into following feed");
    const profile = await call(`/users/${ada.username}`, { token: bo.token });
    assert.equal(profile.data.isFollowing, true);
    assert.equal(profile.data.stats.followers, null);

    await call(`/posts/${postId}/comments`, { method: "POST", token: bo.token, body: { body: "Lovely." } });
    const summary = await call("/notifications/summary", { token: ada.token });
    assert.equal(summary.data.unread, 3); // reaction + follow + comment
    const list = await call("/notifications", { token: ada.token });
    assert.deepEqual(new Set(list.data.items.map((n: { type: string }) => n.type)), new Set(["reaction", "follow", "comment"]));
    await call("/notifications/read", { method: "POST", token: ada.token });
    assert.equal((await call("/notifications/summary", { token: ada.token })).data.unread, 0);
  });

  it("keeps anonymous authors anonymous in replies", async () => {
    await call(`/posts/${anonId}/comments`, { method: "POST", token: ada.token, body: { body: "Thanks for reading" } });
    const replies = await call(`/posts/${anonId}/comments`, { token: bo.token });
    assert.equal(replies.data.items[0].author, null);
    assert.equal(replies.data.items[0].isOriginalPoster, true);
  });

  it("edits, bookmarks and deletes", async () => {
    const edit = await call(`/posts/${postId}`, { method: "PATCH", token: ada.token, body: { body: "Rainy evenings, tea and a book" } });
    assert.ok(edit.data.post.editedAt);
    assert.equal((await call(`/posts/${postId}`, { method: "PATCH", token: bo.token, body: { body: "hijack" } })).status, 403);
    await call(`/posts/${postId}/bookmark`, { method: "POST", token: bo.token });
    const saved = await call("/bookmarks", { token: bo.token });
    assert.equal(saved.data.items[0].id, postId);
    assert.equal(saved.data.items[0].bookmarked, true);
    const results = await call("/search?q=tea book");
    assert.ok(results.data.posts.some((p: { id: string }) => p.id === postId));
    assert.ok((await call(`/search?q=${ada.username}`)).data.people.length >= 1);
  });

  it("delivers letters slowly", async () => {
    const sent = await call("/letters", { method: "POST", token: bo.token, body: { to: ada.username, body: "Dear Ada, ...", pace: "breeze" } });
    assert.equal(sent.status, 201);
    let inbox = await call("/letters", { token: ada.token });
    assert.equal(inbox.data.items.length, 0);
    assert.equal(inbox.data.incoming, 1);
    assert.equal((await call(`/letters/${sent.data.id}`, { token: ada.token })).status, 404);
    const outbox = await call("/letters?box=sent", { token: bo.token });
    assert.equal(outbox.data.items[0].arrived, false);

    // Fast-forward the post office.
    await db.query("UPDATE letters SET deliver_at = now() - interval '1 minute' WHERE id = $1", [sent.data.id]);
    await db.query("UPDATE notifications SET created_at = now() - interval '1 minute' WHERE letter_id = $1", [sent.data.id]);
    inbox = await call("/letters", { token: ada.token });
    assert.equal(inbox.data.items.length, 1);
    assert.equal((await call("/notifications/summary", { token: ada.token })).data.letters, 1);
    const opened = await call(`/letters/${sent.data.id}`, { token: ada.token });
    assert.equal(opened.data.letter.body, "Dear Ada, ...");
    assert.equal((await call("/notifications/summary", { token: ada.token })).data.letters, 0);

    await call("/me", { method: "PATCH", token: ada.token, body: { lettersFrom: "nobody", battery: "recharging" } });
    const blocked = await call("/letters", { method: "POST", token: bo.token, body: { to: ada.username, body: "hi" } });
    assert.equal(blocked.status, 403);
  });

  it("updates profile and rejects foreign keys", async () => {
    const res = await call("/me", { method: "PATCH", token: bo.token, body: { bio: "Quiet reader", showCounts: true } });
    assert.equal(res.data.user.bio, "Quiet reader");
    const bad = await call("/me", { method: "PATCH", token: bo.token, body: { avatarKey: "avatars/00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000.png" } });
    assert.equal(bad.status, 400);
    const moods = await call("/me/moods", { token: ada.token });
    assert.ok(moods.data.items.length >= 1);
    const upload = await fetch(`${base}/uploads?kind=post`, {
      method: "POST",
      headers: { authorization: `Bearer ${bo.token}`, "content-type": "image/png" },
      body: "definitely not an image",
    });
    assert.equal(upload.status, 415);
  });

  it("deletes a post and an account", async () => {
    assert.equal((await call(`/posts/${postId}`, { method: "DELETE", token: ada.token })).status, 204);
    assert.equal((await call(`/posts/${postId}`)).status, 404);
    assert.equal((await call("/me", { method: "DELETE", token: bo.token, body: { password: "wrong" } })).status, 403);
    assert.equal((await call("/me", { method: "DELETE", token: bo.token, body: { password: "quiet-password" } })).status, 204);
    assert.equal((await call("/auth/me", { token: bo.token })).status, 401);
  });
});
