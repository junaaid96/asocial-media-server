// Ably delivery: scoped token requests, and chat events published to the right inboxes.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

// A fake key: token requests are signed locally, and the publisher is stubbed, so nothing reaches Ably.
process.env.ABLY_API_KEY = "testapp.testkey:not-a-real-secret";

const { default: app } = await import("../src/app.js");
const { capabilityFor, inboxChannel, presenceChannel, setAblyPublisher, MAX_PRESENCE_PARTNERS } = await import("../src/ably.js");
const { stopListener } = await import("../src/fanout.js");

const published: { channel: string; name: string; data: any }[] = [];
setAblyPublisher(async (channel, name, data) => {
  published.push({ channel, name, data });
});

const server = createServer(app);
let base = "";
const suffix = `a${Date.now().toString(36).slice(-5)}`;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
after(async () => {
  setAblyPublisher(null);
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
  return { status: res.status, text, data: text ? JSON.parse(text) : null };
}

async function register(name: string): Promise<User> {
  const res = await call("/auth/register", {
    method: "POST",
    body: { email: `${name}_${suffix}@example.com`, username: `${name}_${suffix}`, displayName: name, password: "quiet-password" },
  });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  return { token: res.data.token, username: res.data.user.username, id: res.data.user.id };
}

const waitFor = async (pred: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return pred();
};

describe("ably capabilities", () => {
  it("allows only subscribe on the own inbox, own presence, and partners' presence", () => {
    const cap = capabilityFor("me", ["p1", "p2", "me"]);
    assert.deepEqual(cap, {
      [inboxChannel("me")]: ["subscribe"],
      [presenceChannel("me")]: ["presence", "subscribe"],
      [presenceChannel("p1")]: ["subscribe"],
      [presenceChannel("p2")]: ["subscribe"],
    });
    for (const [channel, ops] of Object.entries(cap)) assert.ok(!ops.includes("publish"), channel);
  });

  it("caps the partner list", () => {
    const many = Array.from({ length: MAX_PRESENCE_PARTNERS + 50 }, (_, i) => `p${i}`);
    assert.equal(Object.keys(capabilityFor("me", many)).length, MAX_PRESENCE_PARTNERS + 2);
  });
});

describe("ably token endpoint and publishing", () => {
  let ana: User;
  let ben: User;
  let eve: User;
  let conversationId = "";

  before(async () => {
    [ana, ben, eve] = await Promise.all([register("ana"), register("ben"), register("eve")]);
    const conv = await call("/conversations", { method: "POST", token: ana.token, body: { username: ben.username } });
    assert.equal(conv.status, 201, conv.text);
    conversationId = conv.data.conversation.id;
  });

  it("requires sign-in", async () => {
    assert.equal((await call("/realtime/token", { method: "POST" })).status, 401);
  });

  it("issues a scoped token request without exposing the key secret", async () => {
    const res = await call("/realtime/token", { method: "POST", token: ana.token });
    assert.equal(res.status, 200, res.text);
    assert.ok(!res.text.includes("not-a-real-secret"));
    const { tokenRequest, channels } = res.data;
    assert.equal(tokenRequest.keyName, "testapp.testkey");
    assert.equal(tokenRequest.clientId, ana.id);
    assert.ok(tokenRequest.mac && tokenRequest.nonce);
    const cap = JSON.parse(tokenRequest.capability);
    assert.deepEqual(cap[inboxChannel(ana.id)], ["subscribe"]);
    assert.deepEqual(cap[presenceChannel(ana.id)], ["presence", "subscribe"]);
    assert.deepEqual(cap[presenceChannel(ben.id)], ["subscribe"]);
    assert.equal(cap[inboxChannel(ben.id)], undefined);
    assert.equal(cap[presenceChannel(eve.id)], undefined);
    assert.equal(channels.inbox, inboxChannel(ana.id));
    assert.deepEqual(channels.partners, [{ userId: ben.id, username: ben.username, conversationId, presence: presenceChannel(ben.id) }]);
  });

  it("publishes new messages to both inboxes", async () => {
    published.length = 0;
    const sent = await call(`/conversations/${conversationId}/messages`, { method: "POST", token: ana.token, body: { body: "hello over ably", clientId: `c-${suffix}` } });
    assert.equal(sent.status, 201, sent.text);
    const msgs = published.filter((p) => p.name === "message" && p.data.message.id === sent.data.message.id);
    assert.deepEqual(msgs.map((p) => p.channel).sort(), [inboxChannel(ana.id), inboxChannel(ben.id)].sort());
    // A retried send (same clientId) doesn't publish again.
    published.length = 0;
    await call(`/conversations/${conversationId}/messages`, { method: "POST", token: ana.token, body: { body: "hello over ably", clientId: `c-${suffix}` } });
    assert.equal(published.filter((p) => p.name === "message").length, 0);
  });

  it("publishes read receipts to the sender", async () => {
    published.length = 0;
    const read = await call(`/conversations/${conversationId}/read`, { method: "POST", token: ben.token });
    assert.equal(read.data.read, 1);
    assert.ok(await waitFor(() => published.some((p) => p.name === "read")));
    const receipt = published.find((p) => p.name === "read")!;
    assert.equal(receipt.channel, inboxChannel(ana.id));
    assert.equal(receipt.data.readerUsername, ben.username);
  });

  it("publishes typing to the other participant only, and refuses outsiders", async () => {
    published.length = 0;
    const res = await call(`/conversations/${conversationId}/typing`, { method: "POST", token: ben.token, body: { typing: true } });
    assert.equal(res.status, 204, res.text);
    const typing = published.filter((p) => p.name === "typing");
    assert.equal(typing.length, 1);
    assert.equal(typing[0]!.channel, inboxChannel(ana.id));
    assert.equal(typing[0]!.data.username, ben.username);
    assert.equal(typing[0]!.data.typing, true);
    const outsider = await call(`/conversations/${conversationId}/typing`, { method: "POST", token: eve.token, body: { typing: true } });
    assert.equal(outsider.status, 404);
    assert.equal((await call(`/conversations/${conversationId}/typing`, { method: "POST", token: ben.token, body: { typing: "yes" } })).status, 400);
  });

  it("keeps working (REST is the source of truth) when Ably publishing fails", async () => {
    setAblyPublisher(async () => {
      throw new Error("ably down");
    });
    const sent = await call(`/conversations/${conversationId}/messages`, { method: "POST", token: ben.token, body: { body: "still delivered" } });
    assert.equal(sent.status, 201, sent.text);
    setAblyPublisher(async (channel, name, data) => {
      published.push({ channel, name, data });
    });
  });

  it("answers 503 when Ably isn't configured", async () => {
    const key = process.env.ABLY_API_KEY;
    delete process.env.ABLY_API_KEY;
    try {
      assert.equal((await call("/realtime/token", { method: "POST", token: ana.token })).status, 503);
    } finally {
      process.env.ABLY_API_KEY = key;
    }
  });

  after(async () => {
    const { db } = await import("../src/db.js");
    await db.query("DELETE FROM users WHERE username = ANY($1)", [[ana.username, ben.username, eve.username]]);
  });
});
