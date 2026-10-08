import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractHashtags, extractMentions, isSafeUrl, plainExcerpt, sanitizeRichText } from "../src/lib/richtext.js";

describe("rich text", () => {
  it("strips HTML and unsafe links but keeps the words", () => {
    assert.equal(sanitizeRichText('Hi <script>alert(1)</script>there'), "Hi alert(1)there");
    assert.equal(sanitizeRichText('<img src=x onerror="alert(1)">ok'), "ok");
    assert.equal(sanitizeRichText("[click](javascript:alert(1))"), "click");
    assert.equal(sanitizeRichText("[docs](https://example.com/a)"), "[docs](https://example.com/a)");
    assert.equal(sanitizeRichText("I <3 tea and 2 < 3"), "I <3 tea and 2 < 3");
    assert.equal(sanitizeRichText("a\u202Eb\u0000c"), "abc");
    // Code is shown literally, so it may contain anything.
    assert.equal(sanitizeRichText("`<b>bold</b>`"), "`<b>bold</b>`");
    assert.equal(sanitizeRichText("**bold** _it_ \n- one\n- two"), "**bold** _it_ \n- one\n- two");
  });

  it("allows only http(s) and mailto URLs", () => {
    assert.ok(isSafeUrl("https://a.b/c"));
    assert.ok(isSafeUrl("mailto:hi@example.com"));
    assert.ok(!isSafeUrl("javascript:alert(1)"));
    assert.ok(!isSafeUrl("data:text/html,hi"));
    assert.ok(!isSafeUrl("//evil.example"));
  });

  it("finds mentions and hashtags outside code", () => {
    assert.deepEqual(extractMentions("hey @Ada and @bo_1, mail me@example.com `@code`"), ["ada", "bo_1"]);
    assert.deepEqual(extractHashtags("#Rainy days #rainy #42 & #tea_time [#x](https://e.com/#frag) `#code`"), ["rainy", "tea_time", "x"]);
  });

  it("makes plain excerpts", () => {
    assert.equal(plainExcerpt("**Bold** and [a link](https://e.com)\n- item"), "Bold and a link item");
  });
});
