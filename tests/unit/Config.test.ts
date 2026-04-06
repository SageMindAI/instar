import { describe, it, expect } from 'vitest';
import { detectTmuxPath, detectClaudePath, loadConfig } from '../../src/core/Config.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Config', () => {
  describe('detectTmuxPath', () => {
    it('finds tmux on this system', () => {
      const tmuxPath = detectTmuxPath();
      // tmux should be installed on the dev machine
      expect(tmuxPath).toBeTruthy();
      expect(tmuxPath).toContain('tmux');
    });
  });

  describe('detectClaudePath', () => {
    it('finds Claude CLI on this system', () => {
      const claudePath = detectClaudePath();
      // Claude CLI may not be installed in CI — only assert format when found
      if (claudePath) {
        expect(claudePath).toContain('claude');
      } else {
        expect(claudePath).toBeNull();
      }
    });
  });

  describe('loadConfig', () => {
    it('respects sessions.claudePath from config.json instead of auto-detecting', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });

      const customClaudePath = '/usr/local/bin/my-claude-wrapper';
      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({
          sessions: { claudePath: customClaudePath },
        }),
      );

      const config = loadConfig(tmpDir);
      expect(config.sessions.claudePath).toBe(customClaudePath);

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('falls back to auto-detected claudePath when config omits it', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-config-test-'));
      const stateDir = path.join(tmpDir, '.instar');
      fs.mkdirSync(stateDir, { recursive: true });

      fs.writeFileSync(
        path.join(stateDir, 'config.json'),
        JSON.stringify({}),
      );

      const config = loadConfig(tmpDir);
      const detected = detectClaudePath();
      // Should use the auto-detected path when config doesn't specify one
      if (detected) {
        expect(config.sessions.claudePath).toBe(detected);
      }

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
