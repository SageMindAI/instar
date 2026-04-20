/**
 * Version-handshake helpers shared by the lifeline forward path and
 * the server's /internal/telegram-forward handler.
 *
 * Signal-vs-authority: this is a structural API-boundary validator
 * (Hard-invariant carve-out in docs/signal-vs-authority.md). The MAJOR/MINOR
 * compatibility rule is a fixed protocol policy, not a judgment call.
 */

export const VERSION_REGEX = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[A-Za-z0-9.-]{1,32})?$/;
export const VERSION_MAX_LEN = 64;
export const PATCH_INFO_THRESHOLD = 10;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export function parseVersion(s: unknown): Semver | null {
  if (typeof s !== 'string') return null;
  if (s.length > VERSION_MAX_LEN) return null;
  if (!VERSION_REGEX.test(s)) return null;
  const [core, prerelease] = s.split('-', 2);
  const [major, minor, patch] = core.split('.').map(Number);
  if (![major, minor, patch].every(n => Number.isFinite(n) && n >= 0)) return null;
  return { major, minor, patch, prerelease };
}

export type HandshakeDecision =
  | { kind: 'accept' }
  | { kind: 'accept-with-patch-info'; patchDiff: number }
  | { kind: 'upgrade-required'; serverVersion: Semver; clientVersion: Semver; serverVersionString: string };

/**
 * Decide the handshake outcome given validated server + client versions.
 *
 * - MAJOR or MINOR differs → upgrade-required (426)
 * - Same MAJOR.MINOR, |PATCH diff| > 10 → accept-with-patch-info (200 + info signal)
 * - Otherwise → accept (200)
 *
 * Boundary: strict `>`. A PATCH diff of exactly 10 stays silent.
 */
export function compareVersions(server: Semver, client: Semver): HandshakeDecision {
  if (server.major !== client.major || server.minor !== client.minor) {
    const serverVersionString = `${server.major}.${server.minor}.${server.patch}`;
    return { kind: 'upgrade-required', serverVersion: server, clientVersion: client, serverVersionString };
  }
  const patchDiff = Math.abs(server.patch - client.patch);
  if (patchDiff > PATCH_INFO_THRESHOLD) {
    return { kind: 'accept-with-patch-info', patchDiff };
  }
  return { kind: 'accept' };
}
