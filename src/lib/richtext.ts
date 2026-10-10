// Posts, replies and messages are stored as a small Markdown subset:
// **bold**, _italic_, `code`, ```code blocks```, "- " / "1. " lists, [links](https://…),
// @mentions and #hashtags. Clients render it into elements (never raw HTML), and the
// server sanitizes on write so stored text stays safe for any other consumer too.

// Control and bidi-override characters. Zero-width joiner/non-joiner (U+200C/U+200D) stay: emoji
// sequences (👨‍👩‍👧) and Bangla/Indic spellings (র‍্যাব) depend on them.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const HTML_COMMENT = /<!--[\s\S]*?(-->|$)/g;
// Real HTML tags only: a known element name and well-formed attributes. Writing like "List<String>",
// "a<b && c>d" or "<3" isn't HTML and stays as written (clients never render stored text as HTML).
const HTML_ELEMENTS =
  "a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|frame|frameset|h[1-6]|head|header|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|marquee|math|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|script|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr|xml|xmp";
const HTML_TAG = new RegExp(
  `<\\/?(?:${HTML_ELEMENTS})(?=[\\s/>])(?:[\\s/]+[a-zA-Z_:][-\\w:.]*(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'=<>\`]+))?)*[\\s/]*>`,
  "gi",
);
// The URL may contain one level of balanced parentheses, e.g. Wikipedia links.
const MD_LINK = /\[([^\]\n]{1,200})\]\(((?:[^()\s]|\([^()\s]*\)){1,2048})\)/g;
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function isSafeUrl(url: string): boolean {
  if (!SAFE_URL.test(url)) return false;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

/** Removes markup that could become executable HTML, keeping the writer's words intact. */
export function sanitizeRichText(input: string): string {
  let text = input.replace(/\r\n?/g, "\n").replace(CONTROL_CHARS, "");
  // Strip tags outside code; code is rendered literally, so it can stay as written.
  text = mapOutsideCode(text, (chunk) =>
    chunk
      .replace(HTML_COMMENT, "")
      .replace(HTML_TAG, "")
      // Links with anything but http(s)/mailto targets (javascript:, data:, vbscript:…) keep only their label.
      .replace(MD_LINK, (whole, label: string, url: string) => (isSafeUrl(url) ? whole : label)),
  );
  return text.replace(/\n{4,}/g, "\n\n\n").trim();
}

/** Applies fn to the parts of text that aren't inside `inline` or ```fenced``` code. */
function mapOutsideCode(text: string, fn: (chunk: string) => string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/g);
  return parts.map((part, i) => (i % 2 === 1 ? part : fn(part))).join("");
}

function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]+`/g, " ");
}

const MENTION = /(^|[^\w@/.])@([a-zA-Z0-9_]{3,24})(?![\w@])/g;
const HASHTAG = /(^|[^\w&#/])#([a-zA-Z0-9_]{1,50})(?!\w)/g;

/** Lower-cased, de-duplicated usernames mentioned outside code (max 20). */
export function extractMentions(text: string): string[] {
  const found = new Set<string>();
  for (const match of stripCode(text).replace(MD_LINK, "$1").matchAll(MENTION)) {
    found.add(match[2]!.toLowerCase());
    if (found.size >= 20) break;
  }
  return [...found];
}

/** Lower-cased, de-duplicated hashtags outside code and link targets (must contain a letter; max 10). */
export function extractHashtags(text: string): string[] {
  const found = new Set<string>();
  for (const match of stripCode(text).replace(MD_LINK, "$1").matchAll(HASHTAG)) {
    const tag = match[2]!.toLowerCase();
    if (!/[a-z]/.test(tag)) continue;
    found.add(tag);
    if (found.size >= 10) break;
  }
  return [...found];
}

/** Plain-text preview: drops Markdown punctuation so excerpts read naturally. */
export function plainExcerpt(text: string, max = 140): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(MD_LINK, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|\s)[_*](\S[^_*\n]*\S|\S)[_*](?=\s|$|[.,!?])/g, "$1$2")
    .replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, "$1")
    .replace(/^\s*([-*]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}
