// End-to-end tests for verification (admin-approved badges) and relationship
// status (partnered labels need both people to confirm).
// Needs DATABASE_URL pointing at a disposable, migrated database.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import app from "../src/app.js";
import { db } from "../src/db.js";

let base = "";
const server = app.listen(0);
const suffix = Math.random().toString(36).slice(-8);

before(() => {
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(() => server.close());

interface User {
  token: string;
  username: string;
  id: string;
}

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

async function register(name: string): Promise<User> {
  const res = await call("/auth/register", {
    method: "POST",
    body: { email: `${name}_${suffix}@example.com`, username: `${name}_${suffix}`, displayName: name, password: "quiet-password" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { token: res.data.token, username: res.data.user.username, id: res.data.user.id };
}

describe("verification and relationships", () => {
  let ada: User, bo: User, cy: User, mod: User;

  before(async () => {
    [ada, bo, cy, mod] = await Promise.all([register("vera"), register("remy"), register("wren"), register("sage")]);
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [mod.id]);
  });

  it("verifies admins by default", async () => {
    const profile = await call(`/users/${mod.username}`);
    assert.equal(profile.data.user.verified, true);
    assert.equal((await call(`/admin/users/${mod.id}/unverify`, { method: "POST", token: mod.token })).status, 400);
  });

  it("requests, approves and rejects verification", async () => {
    assert.equal((await call("/admin/verifications", { token: ada.token })).status, 403);
    const requested = await call("/me/verification", { method: "POST", token: ada.token, body: { note: "It's really me" } });
    assert.equal(requested.status, 201);
    assert.ok(requested.data.pending);
    assert.equal((await call("/me/verification", { method: "POST", token: ada.token, body: {} })).status, 409);

    const queue = (await call("/admin/verifications", { token: mod.token })).data.items;
    const mine = queue.find((r: { user: { username: string } }) => r.user.username === ada.username);
    assert.ok(mine && mine.note === "It's really me");

    const approved = await call(`/admin/verifications/${mine.id}/approve`, { method: "POST", token: mod.token, body: { label: "Artist" } });
    assert.equal(approved.status, 200);
    assert.equal((await call(`/admin/verifications/${mine.id}/approve`, { method: "POST", token: mod.token, body: {} })).status, 409);

    const profile = (await call(`/users/${ada.username}`)).data;
    assert.equal(profile.user.verified, true);
    assert.equal(profile.user.verifiedLabel, "Artist");
    assert.equal((await call("/me/verification", { method: "POST", token: ada.token, body: {} })).status, 400);

    const notes = (await call("/notifications", { token: ada.token })).data.items;
    assert.ok(notes.some((n: { type: string }) => n.type === "verification"));

    // Rejection notifies too, and allows asking again.
    await call("/me/verification", { method: "POST", token: bo.token, body: {} });
    const pending = (await call("/admin/verifications", { token: mod.token })).data.items.find(
      (r: { user: { username: string } }) => r.user.username === bo.username,
    );
    assert.equal((await call(`/admin/verifications/${pending.id}/reject`, { method: "POST", token: mod.token })).status, 200);
    const boNotes = (await call("/notifications", { token: bo.token })).data.items;
    assert.ok(boNotes.some((n: { type: string }) => n.type === "verification"));
    assert.equal((await call("/me/verification", { method: "POST", token: bo.token, body: {} })).status, 201);
    assert.equal((await call("/me/verification", { method: "DELETE", token: bo.token })).status, 200);
    assert.equal((await call("/me/verification", { method: "DELETE", token: bo.token })).status, 404);
  });

  it("verifies and unverifies people directly", async () => {
    assert.equal((await call(`/admin/users/${cy.id}/verify`, { method: "POST", token: mod.token, body: { label: "" } })).status, 200);
    assert.equal((await call(`/users/${cy.username}`)).data.user.verified, true);
    assert.equal((await call(`/admin/users/${cy.id}/verify`, { method: "POST", token: mod.token, body: {} })).status, 409);
    assert.equal((await call(`/admin/users/${cy.id}/unverify`, { method: "POST", token: mod.token })).status, 200);
    assert.equal((await call(`/users/${cy.username}`)).data.user.verified, false);

    const log = (await call("/admin/actions?limit=50", { token: mod.token })).data.items;
    assert.ok(log.some((e: { action: string }) => e.action === "verify_user"));
    assert.ok(log.some((e: { action: string }) => e.action === "unverify_user"));

    const stats = (await call("/admin/stats", { token: mod.token })).data.totals;
    assert.ok(stats.verified >= 2); // the moderator and ada
    assert.equal(typeof stats.pending_verifications, "number");
    const verified = (await call("/admin/users?status=verified", { token: mod.token })).data.items;
    assert.ok(verified.every((u: { verified: boolean }) => u.verified));
  });

  it("shows solo relationship status immediately", async () => {
    assert.equal((await call("/me/relationship/solo", { method: "PUT", token: ada.token, body: { label: "single" } })).status, 200);
    const profile = (await call(`/users/${ada.username}`)).data;
    assert.deepEqual(profile.relationship, { label: "single", partner: null });
    assert.equal((await call("/me/relationship/solo", { method: "PUT", token: ada.token, body: { label: null } })).status, 200);
    assert.equal((await call(`/users/${ada.username}`)).data.relationship, null);
  });

  it("needs both people to confirm a partnered status", async () => {
    assert.equal((await call("/me/relationship", { method: "POST", token: ada.token, body: { label: "married", partnerUsername: ada.username } })).status, 400);
    assert.equal((await call("/me/relationship", { method: "POST", token: ada.token, body: { label: "married", partnerUsername: "nobody-here-xyz" } })).status, 404);

    const sent = await call("/me/relationship", { method: "POST", token: ada.token, body: { label: "in_a_relationship", partnerUsername: `@${bo.username}` } });
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
    // Pending requests stay invisible on both profiles.
    assert.equal((await call(`/users/${ada.username}`)).data.relationship, null);
    assert.equal((await call(`/users/${bo.username}`)).data.relationship, null);
    // …and block a second involvement or a solo label meanwhile.
    assert.equal((await call("/me/relationship", { method: "POST", token: ada.token, body: { label: "engaged", partnerUsername: cy.username } })).status, 409);
    assert.equal((await call("/me/relationship/solo", { method: "PUT", token: ada.token, body: { label: "single" } })).status, 409);

    const boState = (await call("/me/relationship", { token: bo.token })).data;
    assert.equal(boState.incoming.length, 1);
    assert.equal(boState.incoming[0].other.username, ada.username);
    const boNotes = (await call("/notifications", { token: bo.token })).data.items;
    assert.ok(boNotes.some((n: { type: string }) => n.type === "relationship"));

    const confirmed = await call(`/me/relationship/${boState.incoming[0].id}/confirm`, { method: "POST", token: bo.token });
    assert.equal(confirmed.status, 200);
    const adaProfile = (await call(`/users/${ada.username}`)).data;
    const boProfile = (await call(`/users/${bo.username}`)).data;
    assert.equal(adaProfile.relationship.label, "in_a_relationship");
    assert.equal(adaProfile.relationship.partner.username, bo.username);
    assert.equal(boProfile.relationship.partner.username, ada.username);

    // Either side can remove it; both profiles go quiet and the other is told.
    assert.equal((await call("/me/relationship", { method: "DELETE", token: ada.token })).status, 204);
    assert.equal((await call(`/users/${ada.username}`)).data.relationship, null);
    assert.equal((await call(`/users/${bo.username}`)).data.relationship, null);
    const after = (await call("/notifications", { token: bo.token })).data.items;
    assert.ok(after.some((n: { type: string; body: string }) => n.type === "relationship" && n.body.includes("removed")));
  });

  it("lets the partner decline", async () => {
    await call("/me/relationship", { method: "POST", token: bo.token, body: { label: "engaged", partnerUsername: ada.username } });
    const adaState = (await call("/me/relationship", { token: ada.token })).data;
    assert.equal(adaState.incoming.length, 1);
    assert.equal((await call(`/me/relationship/${adaState.incoming[0].id}/decline`, { method: "POST", token: ada.token })).status, 204);
    assert.equal((await call(`/users/${ada.username}`)).data.relationship, null);
    assert.equal((await call("/me/relationship", { method: "DELETE", token: bo.token })).status, 404);
    // Declining frees both sides to try again.
    assert.equal((await call("/me/relationship", { method: "POST", token: bo.token, body: { label: "engaged", partnerUsername: ada.username } })).status, 201);
  });
});
