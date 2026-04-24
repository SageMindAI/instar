/**
 * TelegramMarkdownFormatter — server-side formatter that converts agent-authored
 * GitHub-flavored markdown into Telegram HTML on outbound sends.
 *
 * Ported from Dawn's `telegram_format.py` (the-portal/.claude/scripts/telegram_format.py).
 * Spec: docs/specs/TELEGRAM-MARKDOWN-RENDERER-SPEC.md
 *
 * PR1: module + tests only. Not wired into any send path. PR2 wires into
 * TelegramAdapter.apiCall() and TelegramLifeline.apiCall() behind a canary flag.
 */

export type FormatMode =
  | 'plain'
  | 'html'
  | 'code'
  | 'markdown'
  | 'legacy-passthrough';

export interface FormatResult {
  /** The rendered output text (or the raw input, for `legacy-passthrough`). */
  text: string;
  /**
   * The parse_mode the caller should set on the Bot API call.
   * - `'HTML'` for plain/html/code/markdown.
   * - `undefined` for `legacy-passthrough` — caller MUST use its callsite-historical
   *   parse_mode (the formatter refuses to decide for legacy-passthrough).
   */
  parseMode: 'HTML' | 'Markdown' | undefined;
  /** Lint issue strings (canonical prose; never contains user text). */
  lintIssues: string[];
  /** The mode actually applied (may differ from requested if conversionSkipped). */
  modeApplied: FormatMode;
  /** Output was byte-truncated to fit a Bot API limit. */
  truncated: boolean;
  /**
   * Markdown conversion was bypassed (input > 32KB) and plain mode was applied.
   * Distinct from `truncated` (which is byte-loss).
   */
  conversionSkipped: boolean;
  /**
   * For `legacy-passthrough`: signals to caller that formatter declined to
   * transform the bytes; caller should use its historical parse_mode.
   */
  legacyPassthrough: boolean;
}

/** 32KB hard cap. Above this, markdown conversion is skipped (ReDoS defense). */
export const MAX_INPUT_LENGTH = 32_768;

/** Safe bound for quantifier in italic regex (ReDoS defense). */
const ITALIC_MAX_LEN = 200;

/** Max chars scanned forward in the balanced-paren URL walker. */
const URL_SCAN_MAX = 2048;

// ─── Placeholder sentinels ──────────────────────────────────────────────────
// Use Supplementary-PUA-B (U+100000..U+10FFFD) — near-zero real-world usage,
// invalid in Telegram HTML text anyway. We strip this range from user input
// BEFORE inserting any sentinel, so collision is structurally impossible.
// PUA-A (U+E000..U+F8FF) is NOT used — it frequently collides with user input
// (private emoji, legacy fonts).

// Supplementary-PUA-B is U+100000..U+10FFFD (codepoint max is 0x10FFFF).
// We carve three 20000-wide blocks, one per kind.
const PUA_B_START = 0x100000;
const BLOCK_SIZE = 0x5000; // 20480 entries per kind — plenty
const SENTINEL_CLOSE = String.fromCodePoint(0x10fffd);

const KIND_PRE = 0;
const KIND_TABLE = 1;
const KIND_CODE = 2;

function makeSentinel(kind: number, n: number): string {
  if (n < 0 || n >= BLOCK_SIZE) {
    throw new Error(`sentinel index out of range: ${n}`);
  }
  const code = PUA_B_START + kind * BLOCK_SIZE + n;
  return SENTINEL_CLOSE + String.fromCodePoint(code) + SENTINEL_CLOSE;
}

function decodeSentinelCodepoint(cp: number): { kind: number; n: number } | null {
  const offset = cp - PUA_B_START;
  if (offset < 0) return null;
  const kind = Math.floor(offset / BLOCK_SIZE);
  const n = offset % BLOCK_SIZE;
  if (kind > 2) return null;
  return { kind, n };
}

/** Strip the entire Supplementary-PUA-B range from user input. */
function stripPuaB(s: string): string {
  // Two-surrogate range: 0x100000..0x10FFFD. Regex with /u flag.
  return s.replace(/[\u{100000}-\u{10FFFD}]/gu, '');
}

/** Strip NUL bytes. Always step 0. */
function stripNul(s: string): string {
  return s.replace(/\x00/g, '');
}

// ─── HTML escape ────────────────────────────────────────────────────────────

/** Escape for HTML text nodes. */
export function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Escape for HTML attribute values (href). Distinct from text: also escapes
 * quotes and strips control chars that could break attribute quoting.
 */
export function escapeHtmlAttribute(s: string): string {
  return s
    // Strip C0 controls + DEL + CR/LF (CR/LF already in C0 range).
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── URL safety ─────────────────────────────────────────────────────────────

const SAFE_SCHEMES = new Set(['http', 'https', 'tg', 'mailto']);

/**
 * Check a URL against the scheme allowlist using WHATWG URL parsing.
 * Returns the trimmed+parsed URL string on success, or null on reject.
 *
 * Scheme allowlist: http, https, tg, mailto. Everything else (javascript:,
 * data:, file:, vbscript:, etc.) is refused and the link becomes literal text.
 */
export function isSafeUrl(raw: string): string | null {
  // Trim leading whitespace and C0 controls (URL smuggling defense).
  const trimmed = raw.replace(/^[\s\x00-\x1f]+/, '');
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  const scheme = parsed.protocol.toLowerCase().replace(':', '');
  if (!SAFE_SCHEMES.has(scheme)) return null;
  return trimmed;
}

// ─── Extraction: fenced code, tables, inline code ──────────────────────────

interface Extracted {
  text: string;
  pre: string[];
  table: string[];
  code: string[];
}

/**
 * Step 2: extract fenced code blocks. Replaces each with a PUA sentinel.
 * Inner content HTML-escaped, wrapped in <pre>.
 */
function extractFencedCode(text: string, pre: string[]): string {
  // Bounded fence regex: ``` ... ```, non-greedy.
  // Use a manual scan to avoid regex backtracking on unbalanced fences.
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('```', i)) {
      // Find closing ```
      const start = i + 3;
      const end = text.indexOf('```', start);
      if (end === -1) {
        // No closing — emit literal backticks, keep scanning.
        out.push('```');
        i += 3;
        continue;
      }
      // Optional language tag on the opening line (skip to first \n).
      let contentStart = start;
      const nl = text.indexOf('\n', start);
      if (nl !== -1 && nl < end) {
        contentStart = nl + 1;
      }
      const inner = text.slice(contentStart, end);
      const idx = pre.length;
      pre.push(`<pre>${escapeHtmlText(inner)}</pre>`);
      out.push(makeSentinel(KIND_PRE, idx));
      i = end + 3;
    } else {
      out.push(text[i]);
      i++;
    }
  }
  return out.join('');
}

/**
 * Step 3: extract markdown table blocks. Requires both pipe-rows and an
 * alignment separator row. Escape inner text, wrap whole block in <pre>.
 */
function extractTables(text: string, table: string[]): string {
  const lines = text.split('\n');
  const isRow = (s: string) => /^\s*\|.{1,2000}\|\s*$/.test(s);
  const isSep = (s: string) => /^\s*\|[\s\-:|]{1,2000}\|\s*$/.test(s);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isRow(lines[i])) {
      const block: string[] = [];
      let hasSep = false;
      let j = i;
      while (j < lines.length && isRow(lines[j])) {
        if (isSep(lines[j])) {
          hasSep = true;
        } else {
          block.push(lines[j]);
        }
        j++;
      }
      if (hasSep && block.length > 0) {
        const escaped = block.map(escapeHtmlText).join('\n');
        const idx = table.length;
        table.push(`<pre>${escaped}</pre>`);
        out.push(makeSentinel(KIND_TABLE, idx));
        i = j;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/**
 * Step 4: extract inline code spans (`x`). Non-greedy, newline-bounded.
 */
function extractInlineCode(text: string, code: string[]): string {
  // Bounded quantifier; no nested backticks; newline terminates.
  return text.replace(/`([^`\n]{1,500})`/g, (_m, inner: string) => {
    const idx = code.length;
    code.push(`<code>${escapeHtmlText(inner)}</code>`);
    return makeSentinel(KIND_CODE, idx);
  });
}

// ─── Link scanner (balanced-paren; not regex) ───────────────────────────────

/**
 * Step 11: find `[text](url)` links with a balanced-paren URL scanner so
 * Wikipedia-style URLs like `https://en.wikipedia.org/wiki/Entity_(computer_science)`
 * parse correctly.
 *
 * Input: text where prose is already HTML-escaped (step 5 ran).
 *        `[`, `]`, `(`, `)` survive escape.
 */
function convertLinks(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '[') {
      out.push(ch);
      i++;
      continue;
    }
    // Find matching ] on same line, with bounded length.
    let j = i + 1;
    let foundClose = -1;
    const maxTextEnd = Math.min(text.length, i + 1 + 500);
    while (j < maxTextEnd) {
      const c = text[j];
      if (c === '\n') break;
      if (c === ']') {
        foundClose = j;
        break;
      }
      j++;
    }
    if (foundClose === -1 || text[foundClose + 1] !== '(') {
      out.push(ch);
      i++;
      continue;
    }
    const visibleText = text.slice(i + 1, foundClose);
    // Walk URL with paren balance.
    let k = foundClose + 2;
    let depth = 1;
    const urlStart = k;
    const scanEnd = Math.min(text.length, urlStart + URL_SCAN_MAX);
    let urlEnd = -1;
    while (k < scanEnd) {
      const c = text[k];
      if (c === '\n') break;
      if (c === '\\' && k + 1 < scanEnd) {
        // Backslash: skip next char as literal (does NOT count parens).
        k += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          urlEnd = k;
          break;
        }
      }
      k++;
    }
    if (urlEnd === -1) {
      // Unbalanced — emit literal prefix `[text](` and keep scanning from
      // right after the `(`.
      out.push(text.slice(i, foundClose + 2));
      i = foundClose + 2;
      continue;
    }
    const rawUrl = text.slice(urlStart, urlEnd);
    const safeUrl = isSafeUrl(rawUrl);
    if (safeUrl === null) {
      // Emit the original construct as literal.
      out.push(text.slice(i, urlEnd + 1));
      i = urlEnd + 1;
      continue;
    }
    out.push(`<a href="${escapeHtmlAttribute(safeUrl)}">${visibleText}</a>`);
    i = urlEnd + 1;
  }
  return out.join('');
}

// ─── Emphasis/headings/bullets ──────────────────────────────────────────────

/**
 * Step 6 bold-italic, step 7 bold, step 8 italic (tightened).
 *
 * Order is load-bearing: triple BEFORE double BEFORE single so `***x***` parses
 * as <b><i>x</i></b>, not `**` + `*x*` + `**`.
 */
function applyEmphasis(text: string): string {
  // Bold-italic (triple asterisk). Bounded quantifier.
  text = text.replace(
    /\*\*\*([^*\n]{1,200}?)\*\*\*/g,
    '<b><i>$1</i></b>'
  );
  // Bold (double asterisk).
  text = text.replace(
    /\*\*([^*\n]{1,200}?)\*\*/g,
    '<b>$1</b>'
  );
  // Italic — tightened boundary. Requires word-boundary-like context on both
  // sides. Does NOT match `3*5`, `f(x) = x * y`, `a*b*c`.
  // Using bounded quantifier (ReDoS defense).
  text = text.replace(
    /(^|[\s(,.;:!?])\*(?!\s)([^*\n]{1,200}?)(?<!\s)\*(?=$|[\s),.;:!?])/g,
    '$1<i>$2</i>'
  );
  return text;
}

/** Step 9: headings → <b>. Telegram supports bold, not h1-h6. */
function applyHeadings(text: string): string {
  return text.replace(
    /^(#{1,6})\s+(.{1,2000}?)\s*#*\s*$/gm,
    '<b>$2</b>'
  );
}

/** Step 10: bullets → • */
function applyBullets(text: string): string {
  return text.replace(/^(\s{0,20})[-*+]\s+/gm, '$1• ');
}

// ─── Plain mode (Dawn parity) ──────────────────────────────────────────────

function plainUnicode(text: string): string {
  // Heading: uppercase the heading text.
  text = text.replace(
    /^(#{1,6})\s+(.{1,2000}?)\s*#*\s*$/gm,
    (_m, _h, t: string) => t.toUpperCase()
  );
  text = text.replace(/\*\*\*([^*\n]{1,200}?)\*\*\*/g, '$1');
  text = text.replace(/\*\*([^*\n]{1,200}?)\*\*/g, '$1');
  text = text.replace(
    /(^|[\s(,.;:!?])\*(?!\s)([^*\n]{1,200}?)(?<!\s)\*(?=$|[\s),.;:!?])/g,
    '$1$2'
  );
  text = text.replace(/`([^`\n]{1,500})`/g, "'$1'");
  text = text.replace(/^(\s{0,20})[-*+]\s+/gm, '$1• ');
  return text;
}

// ─── Lint ───────────────────────────────────────────────────────────────────

/**
 * Strip <code>...</code> and <pre>...</pre> spans so lint doesn't flag markdown
 * chars inside deliberately-literal examples.
 *
 * ADVISORY-ONLY — not used by the converter. The converter has its own
 * tokenizer (extractFencedCode / extractInlineCode).
 */
function stripHtmlCodePreForLint(text: string): string {
  // Bounded quantifiers; non-greedy.
  text = text.replace(/<pre>[\s\S]{0,32000}?<\/pre>/g, '');
  text = text.replace(/<code>[\s\S]{0,2000}?<\/code>/g, '');
  return text;
}

/**
 * Lint — canonical messages only. Never contains user text.
 */
export function lintTelegramMarkdown(text: string): string[] {
  const stripped = stripHtmlCodePreForLint(text);
  const issues: string[] = [];
  // Table: requires BOTH a row and an alignment separator.
  const hasTableRow = /^\s*\|.{1,2000}\|\s*$/m.test(stripped);
  const hasTableSep = /^\s*\|[\s\-:|]{1,2000}\|\s*$/m.test(stripped);
  if (hasTableRow && hasTableSep) {
    issues.push('markdown table syntax detected (pipe rows with alignment separator)');
  }
  if (/\*\*([^*\n]{1,200}?)\*\*/.test(stripped)) {
    issues.push('markdown bold syntax detected (double-asterisk)');
  }
  if (/^#{1,6}\s+.{1,2000}$/m.test(stripped)) {
    issues.push('markdown heading syntax detected (leading hash)');
  }
  // Nested markdown: bold-inside-bold or italic-inside-bold literal concern.
  if (/\*\*[^*\n]{0,200}\*[^*\n]{0,200}\*[^*\n]{0,200}\*\*/.test(stripped)) {
    issues.push('nested markdown emphasis detected');
  }
  return issues;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Convert GitHub-flavored markdown to Telegram HTML per spec's 12-step pipeline.
 */
function convertMarkdownToHtml(text: string): string {
  const pre: string[] = [];
  const table: string[] = [];
  const code: string[] = [];

  // Step 2: fenced code.
  text = extractFencedCode(text, pre);
  // Step 3: tables.
  text = extractTables(text, table);
  // Step 4: inline code.
  text = extractInlineCode(text, code);
  // Step 5: HTML-escape remaining prose.
  text = escapeHtmlText(text);
  // Steps 6-8: bold-italic, bold, italic.
  text = applyEmphasis(text);
  // Step 9: headings.
  text = applyHeadings(text);
  // Step 10: bullets.
  text = applyBullets(text);
  // Step 11: links (balanced-paren scan).
  text = convertLinks(text);
  // Step 12: splice placeholders back.
  text = splicePlaceholders(text, pre, table, code);
  return text;
}

function splicePlaceholders(
  text: string,
  pre: string[],
  table: string[],
  code: string[]
): string {
  // Replace every sentinel pattern: SENTINEL_CLOSE + codepoint + SENTINEL_CLOSE.
  const re = /\u{10FFFD}([\u{100000}-\u{10FFFC}])\u{10FFFD}/gu;
  return text.replace(re, (_m, ch: string) => {
    const cp = ch.codePointAt(0)!;
    const dec = decodeSentinelCodepoint(cp);
    if (!dec) return '';
    if (dec.kind === KIND_PRE) return pre[dec.n] ?? '';
    if (dec.kind === KIND_TABLE) return table[dec.n] ?? '';
    if (dec.kind === KIND_CODE) return code[dec.n] ?? '';
    return '';
  });
}

/**
 * Format text for Telegram send.
 *
 * See spec's "Modes — exact contract" and "Markdown conversion rules" sections.
 */
export function formatForTelegram(
  text: string,
  mode: FormatMode = 'markdown'
): FormatResult {
  // legacy-passthrough: byte-for-byte unchanged, parseMode undefined so caller
  // uses its historical mode.
  if (mode === 'legacy-passthrough') {
    return {
      text,
      parseMode: undefined,
      lintIssues: [],
      modeApplied: 'legacy-passthrough',
      truncated: false,
      conversionSkipped: false,
      legacyPassthrough: true,
    };
  }

  // Step 0: strip NUL. ALWAYS first.
  let working = stripNul(text);
  // Defensive: strip PUA-B to prevent sentinel collisions. Range is near-zero
  // real-world usage and invalid in Telegram HTML anyway.
  working = stripPuaB(working);

  const lintIssues = lintTelegramMarkdown(working);

  // Step 1: length guard (ReDoS defense). Applies to markdown conversion only.
  if (mode === 'markdown' && working.length > MAX_INPUT_LENGTH) {
    // Fall back to plain.
    const plain = escapeHtmlText(plainUnicode(working));
    return {
      text: plain,
      parseMode: 'HTML',
      lintIssues,
      modeApplied: 'plain',
      truncated: false,
      conversionSkipped: true,
      legacyPassthrough: false,
    };
  }

  if (mode === 'html') {
    return {
      text: working,
      parseMode: 'HTML',
      lintIssues,
      modeApplied: 'html',
      truncated: false,
      conversionSkipped: false,
      legacyPassthrough: false,
    };
  }

  if (mode === 'code') {
    return {
      text: `<pre>${escapeHtmlText(working)}</pre>`,
      parseMode: 'HTML',
      lintIssues,
      modeApplied: 'code',
      truncated: false,
      conversionSkipped: false,
      legacyPassthrough: false,
    };
  }

  if (mode === 'plain') {
    return {
      text: escapeHtmlText(plainUnicode(working)),
      parseMode: 'HTML',
      lintIssues,
      modeApplied: 'plain',
      truncated: false,
      conversionSkipped: false,
      legacyPassthrough: false,
    };
  }

  // markdown (default)
  return {
    text: convertMarkdownToHtml(working),
    parseMode: 'HTML',
    lintIssues,
    modeApplied: 'markdown',
    truncated: false,
    conversionSkipped: false,
    legacyPassthrough: false,
  };
}

/**
 * Convenience: `format(text, mode)` → `{ text, parseMode }` shape per the
 * parent prompt. Full result available via `formatForTelegram()`.
 */
export function format(
  text: string,
  mode: FormatMode = 'markdown'
): { text: string; parseMode: 'HTML' | 'Markdown' | undefined } {
  const r = formatForTelegram(text, mode);
  return { text: r.text, parseMode: r.parseMode };
}

/** Short alias for the lint function. */
export function lint(text: string): string[] {
  return lintTelegramMarkdown(text);
}
