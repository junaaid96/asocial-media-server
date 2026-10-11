import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDemoWriteAllowed } from "../src/lib/demo.js";

describe("demo account guard", () => {
  it("lets demo accounts browse and react", () => {
    assert.ok(isDemoWriteAllowed("GET", "/api/admin/stats"));
    assert.ok(isDemoWriteAllowed("PUT", "/api/posts/abc/reaction"));
    assert.ok(isDemoWriteAllowed("POST", "/api/users/sam/follow"));
    assert.ok(isDemoWriteAllowed("POST", "/api/auth/login"));
  });
  it("blocks publishing, messaging, moderation and account changes", () => {
    for (const [m, p] of [
      ["POST", "/api/posts"], ["PATCH", "/api/posts/abc"], ["POST", "/api/posts/abc/comments"],
      ["POST", "/api/letters"], ["POST", "/api/conversations/x/messages"], ["POST", "/api/uploads"],
      ["POST", "/api/admin/users/x/suspend"], ["POST", "/api/admin/posts/x/hide"], ["POST", "/api/reports"],
      ["PATCH", "/api/me"], ["DELETE", "/api/me"],
    ]) assert.equal(isDemoWriteAllowed(m!, p!), false, `${m} ${p}`);
  });
});
