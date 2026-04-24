import { describe, it, expect } from 'vitest';
import {
  formatForTelegram,
  format,
  lint,
  lintTelegramMarkdown,
  escapeHtmlText,
  escapeHtmlAttribute,
  isSafeUrl,
  MAX_INPUT_LENGTH,
  type FormatMode,
} from '../../src/messaging/TelegramMarkdownFormatter.js';

// ─── HTML escape primitives ─────────────────────────────────────────────────

describe('escapeHtmlText', () => {
  it('escapes < > &', () => {
    expect(escapeHtmlText('<script>alert(1)&')).toBe(
      '&lt;script&gt;alert(1)&amp;'
    );
  });
  it('does NOT escape quotes (text context)', () => {
    expect(escapeHtmlText('"hello"')).toBe('"hello"');
    expect(escapeHtmlText("it's")).toBe("it's");
  });
  it('leaves plain text unchanged', () => {
    expect(escapeHtmlText('hello world')).toBe('hello world');
  });
});

describe('escapeHtmlAttribute', () => {
  it('escapes double quote to &quot;', () => {
    expect(escapeHtmlAttribute('a"b')).toBe('a&quot;b');
  });
  it('escapes single quote to &#39;', () => {
    expect(escapeHtmlAttribute("a'b")).toBe('a&#39;b');
  });
  it('escapes < > &', () => {
    expect(escapeHtmlAttribute('<a&b>')).toBe('&lt;a&amp;b&gt;');
  });
  it('strips C0 controls, DEL, CR, LF, NUL', () => {
    expect(escapeHtmlAttribute('a\x00b\rc\nd\x7fe\x1ff')).toBe('abcdef');
  });
  it('handles mixed attack payload', () => {
    const input = 'javascript:alert("x")\n<img>';
    const result = escapeHtmlAttribute(input);
    expect(result).not.toContain('\n');
    expect(result).not.toContain('"');
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
  });
});

// ─── URL safety ─────────────────────────────────────────────────────────────

describe('isSafeUrl', () => {
  it('allows http', () => {
    expect(isSafeUrl('http://example.com')).toBe('http://example.com');
  });
  it('allows https', () => {
    expect(isSafeUrl('https://example.com')).toBe('https://example.com');
  });
  it('allows tg', () => {
    expect(isSafeUrl('tg://resolve?domain=foo')).not.toBeNull();
  });
  it('allows mailto', () => {
    expect(isSafeUrl('mailto:foo@bar.com')).not.toBeNull();
  });
  it('rejects javascript:', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBeNull();
  });
  it('rejects data:', () => {
    expect(isSafeUrl('data:text/html,<script>')).toBeNull();
  });
  it('rejects file:', () => {
    expect(isSafeUrl('file:///etc/passwd')).toBeNull();
  });
  it('rejects vbscript:', () => {
    expect(isSafeUrl('vbscript:msgbox(1)')).toBeNull();
  });
  it('rejects malformed URL', () => {
    expect(isSafeUrl('not a url')).toBeNull();
  });
  it('rejects empty/whitespace', () => {
    expect(isSafeUrl('')).toBeNull();
    expect(isSafeUrl('   ')).toBeNull();
  });
  it('trims leading whitespace and control chars (URL smuggling)', () => {
    expect(isSafeUrl('\t  https://example.com')).toBe('https://example.com');
    expect(isSafeUrl('\x01https://example.com')).toBe('https://example.com');
  });
  it('rejects uppercase-scheme attack (case-insensitive match)', () => {
    // URL normalizes scheme; uppercase HTTPS should still resolve to https.
    expect(isSafeUrl('HTTPS://example.com')).not.toBeNull();
  });
});

// ─── Modes ─────────────────────────────────────────────────────────────────

describe('formatForTelegram — plain mode', () => {
  it('escapes HTML', () => {
    const r = formatForTelegram('<script>', 'plain');
    expect(r.text).toBe('&lt;script&gt;');
    expect(r.parseMode).toBe('HTML');
  });
  it('converts **bold** to plain text', () => {
    const r = formatForTelegram('**hi**', 'plain');
    expect(r.text).toBe('hi');
  });
  it('converts `code` to quoted text', () => {
    const r = formatForTelegram('`x`', 'plain');
    expect(r.text).toBe("'x'");
  });
  it('uppercases headings', () => {
    const r = formatForTelegram('# Hello', 'plain');
    expect(r.text).toBe('HELLO');
  });
  it('converts bullets to •', () => {
    const r = formatForTelegram('- item', 'plain');
    expect(r.text).toBe('• item');
  });
});

describe('formatForTelegram — html mode', () => {
  it('passes text through unchanged', () => {
    const r = formatForTelegram('<b>hi</b>', 'html');
    expect(r.text).toBe('<b>hi</b>');
    expect(r.parseMode).toBe('HTML');
  });
});

describe('formatForTelegram — code mode', () => {
  it('wraps in <pre> and escapes inner', () => {
    const r = formatForTelegram('<hi>', 'code');
    expect(r.text).toBe('<pre>&lt;hi&gt;</pre>');
    expect(r.parseMode).toBe('HTML');
  });
});

describe('formatForTelegram — markdown mode', () => {
  it('converts **bold** to <b>', () => {
    const r = formatForTelegram('**hi**', 'markdown');
    expect(r.text).toBe('<b>hi</b>');
    expect(r.parseMode).toBe('HTML');
  });
  it('converts ***x*** to <b><i>x</i></b>', () => {
    const r = formatForTelegram('***x***', 'markdown');
    expect(r.text).toBe('<b><i>x</i></b>');
  });
  it('converts `code` to <code>', () => {
    const r = formatForTelegram('`x`', 'markdown');
    expect(r.text).toBe('<code>x</code>');
  });
  it('converts # heading to <b>', () => {
    const r = formatForTelegram('# Hi', 'markdown');
    expect(r.text).toBe('<b>Hi</b>');
  });
  it('converts bullets to •', () => {
    const r = formatForTelegram('- a\n- b', 'markdown');
    expect(r.text).toBe('• a\n• b');
  });
  it('escapes < > & in prose', () => {
    const r = formatForTelegram('<script>&', 'markdown');
    expect(r.text).toBe('&lt;script&gt;&amp;');
  });
  it('tables become <pre>', () => {
    const table = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    const r = formatForTelegram(table, 'markdown');
    expect(r.text).toContain('<pre>');
    expect(r.text).toContain('| a | b |');
    expect(r.text).toContain('| 1 | 2 |');
  });
  it('fenced code blocks become <pre>', () => {
    const r = formatForTelegram('```\nhi <world>\n```', 'markdown');
    expect(r.text).toContain('<pre>hi &lt;world&gt;');
  });
  it('fenced code with language tag strips the lang line', () => {
    const r = formatForTelegram('```js\nconst x = 1;\n```', 'markdown');
    expect(r.text).toContain('<pre>const x = 1;');
    expect(r.text).not.toContain('<pre>js');
  });
  it('does NOT interpret markdown inside inline code', () => {
    const r = formatForTelegram('`**bold**`', 'markdown');
    expect(r.text).toBe('<code>**bold**</code>');
  });
  it('does NOT interpret markdown inside fenced code', () => {
    const r = formatForTelegram('```\n**nope**\n```', 'markdown');
    expect(r.text).toContain('**nope**');
    expect(r.text).not.toContain('<b>nope</b>');
  });
});

describe('formatForTelegram — legacy-passthrough mode', () => {
  it('returns input byte-for-byte unchanged', () => {
    const input = '**bold** `code` # heading | table |\nwith NUL\x00 and PUA \u{100000}';
    const r = formatForTelegram(input, 'legacy-passthrough');
    expect(r.text).toBe(input);
    expect(r.text.length).toBe(input.length);
  });
  it('signals legacyPassthrough: true', () => {
    const r = formatForTelegram('x', 'legacy-passthrough');
    expect(r.legacyPassthrough).toBe(true);
  });
  it('returns parseMode undefined so caller uses its historical mode', () => {
    const r = formatForTelegram('x', 'legacy-passthrough');
    expect(r.parseMode).toBeUndefined();
  });
  it('emits no lint issues (skipped)', () => {
    const r = formatForTelegram('**bold** # heading', 'legacy-passthrough');
    expect(r.lintIssues).toEqual([]);
  });
});

// ─── Italic edge cases ─────────────────────────────────────────────────────

describe('italic edge cases', () => {
  it('does NOT match arithmetic 3*5', () => {
    const r = formatForTelegram('3*5=15', 'markdown');
    expect(r.text).toBe('3*5=15');
    expect(r.text).not.toContain('<i>');
  });
  it('does NOT match f(x) = x * y', () => {
    const r = formatForTelegram('f(x) = x * y', 'markdown');
    expect(r.text).not.toContain('<i>');
  });
  it('does NOT match a*b*c (no word boundaries)', () => {
    const r = formatForTelegram('a*b*c', 'markdown');
    expect(r.text).not.toContain('<i>');
  });
  it('matches *valid italic*', () => {
    const r = formatForTelegram('this is *valid italic* here', 'markdown');
    expect(r.text).toContain('<i>valid italic</i>');
  });
  it('does NOT match *unterminated', () => {
    const r = formatForTelegram('*unterminated text', 'markdown');
    expect(r.text).not.toContain('<i>');
  });
});

// ─── Link safety ───────────────────────────────────────────────────────────

describe('links', () => {
  it('converts [text](https://x) to <a>', () => {
    const r = formatForTelegram('[hi](https://example.com)', 'markdown');
    expect(r.text).toBe('<a href="https://example.com">hi</a>');
  });
  it('handles Wikipedia-style URL with parens (balanced-paren scan)', () => {
    const r = formatForTelegram(
      '[Entity](https://en.wikipedia.org/wiki/Entity_(computer_science))',
      'markdown'
    );
    expect(r.text).toBe(
      '<a href="https://en.wikipedia.org/wiki/Entity_(computer_science)">Entity</a>'
    );
  });
  it('handles deeply nested parens', () => {
    const r = formatForTelegram(
      '[x](https://a.com/foo(bar(baz))qux)',
      'markdown'
    );
    expect(r.text).toContain('<a href="https://a.com/foo(bar(baz))qux">x</a>');
  });
  it('rejects javascript: as literal text (no <a href>)', () => {
    const r = formatForTelegram('[click](javascript:alert(1))', 'markdown');
    expect(r.text).not.toContain('<a ');
    expect(r.text).not.toContain('href=');
  });
  it('rejects data: as literal text', () => {
    const r = formatForTelegram('[x](data:text/html,<script>)', 'markdown');
    expect(r.text).not.toContain('<a ');
  });
  it('escapes quotes in URL attribute', () => {
    const r = formatForTelegram('[x](https://a.com/"quote")', 'markdown');
    // " in URL should become &quot; in attribute value.
    expect(r.text).not.toMatch(/href="[^"]*"[^"]*"/);
  });
  it('emits literal text for malformed URL', () => {
    const r = formatForTelegram('[x](not a url)', 'markdown');
    expect(r.text).not.toContain('<a ');
  });
  it('emits literal text for unbalanced URL (fallback)', () => {
    const r = formatForTelegram('[x](https://a.com/foo(bar', 'markdown');
    // Should NOT emit <a>.
    expect(r.text).not.toContain('<a ');
  });
});

// ─── Lint ─────────────────────────────────────────────────────────────────

describe('lint', () => {
  it('detects markdown tables', () => {
    const issues = lint('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(issues.some(i => i.includes('table'))).toBe(true);
  });
  it('does NOT flag single pipe-row without separator', () => {
    const issues = lint('| not | a | table |');
    expect(issues.some(i => i.includes('table'))).toBe(false);
  });
  it('detects **bold**', () => {
    const issues = lint('hello **world**');
    expect(issues.some(i => i.includes('bold'))).toBe(true);
  });
  it('detects # headings', () => {
    const issues = lint('# Heading');
    expect(issues.some(i => i.includes('heading'))).toBe(true);
  });
  it('detects nested markdown', () => {
    const issues = lint('**bold *italic* more**');
    expect(issues.some(i => i.includes('nested'))).toBe(true);
  });
  it('lint messages NEVER contain user text or markdown tokens', () => {
    const issues = lint('# SECRET_TOKEN **pwn**');
    for (const msg of issues) {
      expect(msg).not.toContain('SECRET_TOKEN');
      expect(msg).not.toContain('**pwn**');
      expect(msg).not.toMatch(/\*\*[^(]/);  // no literal ** other than in parens
    }
  });
  it('carves out literal examples inside <code>', () => {
    const issues = lint('see <code>**bold**</code> syntax');
    // The ** inside <code> should be stripped before lint.
    expect(issues.some(i => i.includes('bold'))).toBe(false);
  });
  it('carves out literal examples inside <pre>', () => {
    const issues = lint('<pre>| a | b |\n| --- | --- |</pre>');
    expect(issues.some(i => i.includes('table'))).toBe(false);
  });
});

// ─── Security: NUL and PUA-B stripping ────────────────────────────────────

describe('security hardening', () => {
  it('strips NUL bytes as first step', () => {
    const r = formatForTelegram('a\x00b\x00c', 'markdown');
    expect(r.text).toBe('abc');
  });
  it('strips PUA-B range (sentinel collision defense)', () => {
    const sentinel = String.fromCodePoint(0x100000);
    const close = String.fromCodePoint(0x10fffd);
    const r = formatForTelegram(`hi${sentinel}${close}there`, 'markdown');
    expect(r.text).not.toContain(sentinel);
    expect(r.text).not.toContain(close);
  });
  it('user-supplied PUA-B cannot forge a placeholder', () => {
    // Attempt: inject what looks like a sentinel to splice out a <pre>.
    const sentinel = String.fromCodePoint(0x10fffd) +
      String.fromCodePoint(0x100001) +
      String.fromCodePoint(0x10fffd);
    const r = formatForTelegram(`prefix${sentinel}suffix`, 'markdown');
    // The attempted sentinel should be stripped, not resolved.
    expect(r.text).toBe('prefixsuffix');
  });
});

// ─── Length guard ─────────────────────────────────────────────────────────

describe('32KB length guard', () => {
  it('32KB exact is accepted', () => {
    const input = 'a'.repeat(MAX_INPUT_LENGTH);
    const r = formatForTelegram(input, 'markdown');
    expect(r.conversionSkipped).toBe(false);
  });
  it('32KB+1 triggers conversionSkipped fallback to plain', () => {
    const input = 'a'.repeat(MAX_INPUT_LENGTH + 1);
    const r = formatForTelegram(input, 'markdown');
    expect(r.conversionSkipped).toBe(true);
    expect(r.modeApplied).toBe('plain');
  });
  it('conversionSkipped is distinct from truncated', () => {
    const input = 'a'.repeat(MAX_INPUT_LENGTH + 1);
    const r = formatForTelegram(input, 'markdown');
    expect(r.truncated).toBe(false);  // no bytes lost
    expect(r.conversionSkipped).toBe(true);
  });
});

// ─── ReDoS fuzz ───────────────────────────────────────────────────────────

describe('ReDoS fuzz', () => {
  const SEED_INPUTS = [
    // Nested asterisks
    '*'.repeat(100),
    '**'.repeat(100),
    '***'.repeat(100),
    // Nested brackets
    '['.repeat(100) + ']'.repeat(100),
    // Backticks
    '`'.repeat(500),
    // Fences
    '```'.repeat(100),
    // Parens
    '(' + 'x('.repeat(100) + 'y' + ')'.repeat(100),
    // Mixed
    '**' + '*'.repeat(500) + '**',
    // Long single line bold-italic-like
    '***' + 'a'.repeat(300) + '***',
    // Table-like
    '|'.repeat(1000),
    // URL with many parens
    '[x](https://a.com/' + '(x)'.repeat(100) + ')',
    // Heading with many hashes
    '#'.repeat(50) + ' ' + 'x'.repeat(500),
  ];

  it.each(SEED_INPUTS)('p99 < 50ms for pathological input %#', (input) => {
    const start = performance.now();
    const r = formatForTelegram(input, 'markdown');
    const elapsed = performance.now() - start;
    expect(r.text).toBeDefined();
    // Generous bound (spec says p99 <5ms at 4KB; we run tiny inputs with
    // CI variance). 50ms floor catches actual ReDoS (which hangs indefinitely).
    expect(elapsed).toBeLessThan(50);
  });

  it('deterministic pseudo-random fuzz (1000 iterations)', () => {
    // Mulberry32 seeded RNG for reproducibility.
    let seed = 0xc0ffee;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const chars = '*`[](){}|#-_\\/abc\n ';
    for (let i = 0; i < 1000; i++) {
      const len = Math.floor(rand() * 200);
      let s = '';
      for (let j = 0; j < len; j++) {
        s += chars[Math.floor(rand() * chars.length)];
      }
      const start = performance.now();
      formatForTelegram(s, 'markdown');
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(100);
    }
  }, 30_000);
});

// ─── Idempotency ──────────────────────────────────────────────────────────

describe('idempotency', () => {
  const FIXTURES = [
    '**bold**',
    '*italic*',
    '`code`',
    '# heading',
    '- bullet',
    '```\npre\n```',
    '[link](https://example.com)',
    '[wiki](https://en.wikipedia.org/wiki/X_(y))',
    'plain prose',
    'multi\nline\ntext',
    '<script>alert(1)</script>',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
  ];

  it.each(FIXTURES)('format is deterministic: %s', (fixture) => {
    const a = formatForTelegram(fixture, 'markdown').text;
    const b = formatForTelegram(fixture, 'markdown').text;
    expect(a).toBe(b);
  });

  it('html mode is trivially idempotent', () => {
    const x = '<b>hi</b>';
    expect(formatForTelegram(formatForTelegram(x, 'html').text, 'html').text).toBe(x);
  });

  it('markdown mode is idempotent on HTML-only input', () => {
    // After one pass, markdown-escape prose. Second pass on that plain prose
    // (which has no markdown tokens or HTML chars) should be a fixed point.
    const x = 'hello world';
    const r1 = formatForTelegram(x, 'markdown').text;
    const r2 = formatForTelegram(r1, 'markdown').text;
    expect(r2).toBe(r1);
  });

  it('plain mode is idempotent on plain input', () => {
    const x = 'hello world';
    const r1 = formatForTelegram(x, 'plain').text;
    const r2 = formatForTelegram(r1, 'plain').text;
    expect(r2).toBe(r1);
  });

  it('legacy-passthrough is trivially idempotent', () => {
    const x = '**bold** `x`';
    const r1 = formatForTelegram(x, 'legacy-passthrough').text;
    const r2 = formatForTelegram(r1, 'legacy-passthrough').text;
    expect(r2).toBe(x);
  });
});

// ─── format() convenience shape ──────────────────────────────────────────

describe('format() convenience shape', () => {
  it('returns { text, parseMode }', () => {
    const r = format('**hi**', 'markdown');
    expect(r.text).toBe('<b>hi</b>');
    expect(r.parseMode).toBe('HTML');
  });
  it('legacy-passthrough returns parseMode undefined', () => {
    const r = format('hi', 'legacy-passthrough');
    expect(r.parseMode).toBeUndefined();
  });
});

// ─── Extended escape assertions ──────────────────────────────────────────

describe('escape behavior round-trip', () => {
  it('<script> in text becomes &lt;script&gt;', () => {
    const r = formatForTelegram('<script>', 'markdown');
    expect(r.text).toBe('&lt;script&gt;');
  });
  it('" in URL attribute becomes &quot;', () => {
    // Test escapeHtmlAttribute directly (URLs with " are rare but testable).
    expect(escapeHtmlAttribute('"')).toBe('&quot;');
  });
});

// ─── Nested markdown grammar ─────────────────────────────────────────────

describe('nested markdown', () => {
  it('triple asterisk becomes bold-italic', () => {
    const r = formatForTelegram('***hi***', 'markdown');
    expect(r.text).toBe('<b><i>hi</i></b>');
  });
  it('inline code inside bold leaves code span intact', () => {
    const r = formatForTelegram('**and `code`**', 'markdown');
    expect(r.text).toContain('<code>code</code>');
    expect(r.text).toContain('<b>');
  });
});

// ─── Lint function alias ─────────────────────────────────────────────────

describe('lint aliases', () => {
  it('lint() === lintTelegramMarkdown()', () => {
    const input = '**bold**';
    expect(lint(input)).toEqual(lintTelegramMarkdown(input));
  });
});
