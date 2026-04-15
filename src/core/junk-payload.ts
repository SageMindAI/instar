/**
 * junk-payload — classifier for debug/sanity-check strings that shouldn't
 * reach the user (e.g., a stray "test" leaked from a reply-pipe validation).
 *
 * Keep the list conservative. False positives are painful (blocking a real
 * short reply); false negatives only leak the exact string that was tried,
 * and the agent will notice and not repeat.
 */

const JUNK_WORDS = new Set<string>([
  'test', 'testing', 'testmsg', 'tst',
  'asdf', 'asdfasdf', 'qwerty',
  'foo', 'foobar', 'bar', 'baz', 'qux',
  'ping', 'pong', 'debug', 'trace', 'log',
  'hi', 'hello', 'hey', 'yo',
  'x', 'y', 'z', 'a', 'b', 'c',
  'abc', '123', 'xxx', 'zzz',
]);

export interface JunkCheckResult {
  junk: boolean;
  reason?: string;
}

export function isJunkPayload(text: string): JunkCheckResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { junk: true, reason: 'empty or whitespace-only' };
  }
  const words = trimmed.split(/\s+/);
  if (words.length === 1 && trimmed.length < 16) {
    const normalized = trimmed.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (JUNK_WORDS.has(normalized)) {
      return { junk: true, reason: `matches known debug token "${normalized}"` };
    }
  }
  return { junk: false };
}
