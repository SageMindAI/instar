/**
 * Regression tests for MCP stdio-server exclusion in SessionWatchdog.
 *
 * Historical bug: EXCLUDED_PATTERNS caught specific MCP servers by name
 * (playwright-mcp, exa-mcp-server, claude-in-chrome-mcp) but missed
 * workspace-mcp (Google Workspace MCP via `uv tool uvx workspace-mcp`).
 * Result: workspace-mcp hit the 3-minute stuck threshold, got Ctrl+C'd and
 * SIGTERM'd, killing a legitimately long-running MCP server.
 *
 * Fix: generic `-mcp` token regex so any future *-mcp executable is
 * auto-protected without code changes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionWatchdog } from '../../src/monitoring/SessionWatchdog.js';

function config() {
  return {
    stateDir: '/tmp/test-watchdog-mcp',
    sessions: { tmuxPath: 'tmux' },
    monitoring: { watchdog: { enabled: true, stuckCommandSec: 180 } },
  } as any;
}

describe('SessionWatchdog MCP exclusion', () => {
  let watchdog: SessionWatchdog;
  beforeEach(() => {
    watchdog = new SessionWatchdog(config(), {} as any, {} as any);
  });

  const isExcluded = (cmd: string): boolean => (watchdog as any).isExcluded(cmd);

  describe('workspace-mcp (the regression case)', () => {
    it('excludes uvx workspace-mcp', () => {
      expect(isExcluded('/opt/homebrew/bin/uv tool uvx workspace-mcp --tool-tier complete')).toBe(true);
    });

    it('excludes bare workspace-mcp executable', () => {
      expect(isExcluded('workspace-mcp')).toBe(true);
    });
  });

  describe('generic -mcp pattern', () => {
    it('excludes foo-mcp (any future MCP server)', () => {
      expect(isExcluded('/usr/local/bin/foo-mcp --port 8080')).toBe(true);
    });

    it('excludes npx-launched bar-mcp', () => {
      expect(isExcluded('node /path/to/bar-mcp/index.js')).toBe(true);
    });

    it('excludes bar-mcp-server variant', () => {
      expect(isExcluded('/opt/bin/bar-mcp-server --verbose')).toBe(true);
    });

    it('excludes @scope/foo-mcp package path', () => {
      expect(isExcluded('node /node_modules/@scope/foo-mcp/dist/index.js')).toBe(true);
    });

    it('excludes claude-in-chrome-mcp (multi-hyphen name)', () => {
      expect(isExcluded('claude-in-chrome-mcp --port 9000')).toBe(true);
    });

    it('excludes @playwright/mcp (bare mcp after /)', () => {
      expect(isExcluded('node /path/@playwright/mcp')).toBe(true);
      expect(isExcluded('npx @playwright/mcp')).toBe(true);
    });

    it('excludes bar-mcp-server.js (file extension after suffix)', () => {
      expect(isExcluded('node /path/bar-mcp-server.js')).toBe(true);
    });

    it('excludes payments-mcp (previously literal)', () => {
      expect(isExcluded('node /path/payments-mcp/index.js')).toBe(true);
    });

    it('excludes exa-mcp-server in npx-style invocation', () => {
      expect(isExcluded('/opt/bin/node /path/exa-mcp-server/dist/cli.js')).toBe(true);
    });
  });

  describe('pre-existing MCP exclusions still work', () => {
    it('excludes playwright-persistent', () => {
      expect(isExcluded('playwright-persistent --some-flag')).toBe(true);
    });

    it('excludes mcp-stdio-entry', () => {
      expect(isExcluded('node /path/mcp-stdio-entry.js')).toBe(true);
    });

    it('excludes exa-mcp-server', () => {
      expect(isExcluded('node /path/exa-mcp-server/dist/index.js')).toBe(true);
    });

    it('excludes caffeinate', () => {
      expect(isExcluded('/usr/bin/caffeinate -i')).toBe(true);
    });
  });

  describe('does not over-match', () => {
    it('does NOT exclude plain python', () => {
      expect(isExcluded('python3 /path/to/script.py')).toBe(false);
    });

    it('does NOT exclude vitest', () => {
      expect(isExcluded('node /path/node_modules/.bin/vitest run')).toBe(false);
    });

    it('does NOT exclude unrelated strings containing "mcp" as a substring', () => {
      // "scope" does not contain -mcp as a token
      expect(isExcluded('/usr/bin/some-scope-checker')).toBe(false);
      expect(isExcluded('/usr/bin/bmcp-tool')).toBe(false); // mid-word mcp
    });

    it('does NOT exclude a shell invocation that merely mentions -mcp in args', () => {
      // The regex needs token boundary — an arg containing -mcp to another
      // tool should not exclude. (Edge case: if someone does
      // `node other-tool.js --config=foo-mcp.json` — "foo-mcp" is followed
      // by `.json` so the trailing `$|\s` guard still matches... but that
      // command IS effectively a long-running thing referencing an mcp
      // config. Accepting this as a safe over-match.)
      // Direct negative: a tool called "helper" passed `-mcpcfg`.
      expect(isExcluded('/usr/bin/helper --mcpcfg=x')).toBe(false);
    });
  });
});
