import { describe, it, expect, vi } from 'vitest';
import { CommandRouter, type CommandContext } from '../../../src/messaging/shared/CommandRouter.js';

describe('CommandRouter', () => {
  function createRouter(platform = 'telegram') {
    return new CommandRouter(platform);
  }

  // ── Parsing ──────────────────────────────────────────

  describe('parse', () => {
    it('parses simple commands', () => {
      const router = createRouter();
      expect(router.parse('/status')).toEqual({ command: 'status', args: '' });
      expect(router.parse('/help')).toEqual({ command: 'help', args: '' });
    });

    it('parses commands with arguments', () => {
      const router = createRouter();
      expect(router.parse('/claim my-session')).toEqual({ command: 'claim', args: 'my-session' });
      expect(router.parse('/link test session name')).toEqual({ command: 'link', args: 'test session name' });
    });

    it('lowercases command names', () => {
      const router = createRouter();
      expect(router.parse('/Status')).toEqual({ command: 'status', args: '' });
      expect(router.parse('/HELP')).toEqual({ command: 'help', args: '' });
    });

    it('handles hyphenated commands', () => {
      const router = createRouter();
      expect(router.parse('/switch-account dawn')).toEqual({ command: 'switch-account', args: 'dawn' });
    });

    it('handles underscored commands', () => {
      const router = createRouter();
      expect(router.parse('/my_command arg')).toEqual({ command: 'my_command', args: 'arg' });
    });

    it('trims whitespace', () => {
      const router = createRouter();
      expect(router.parse('  /status  ')).toEqual({ command: 'status', args: '' });
      expect(router.parse('/claim   my-session  ')).toEqual({ command: 'claim', args: 'my-session' });
    });

    it('returns null for non-commands', () => {
      const router = createRouter();
      expect(router.parse('hello')).toBeNull();
      expect(router.parse('not a command')).toBeNull();
      expect(router.parse('')).toBeNull();
      expect(router.parse('  ')).toBeNull();
    });

    it('returns null for invalid command formats', () => {
      const router = createRouter();
      expect(router.parse('/ space')).toBeNull();
      expect(router.parse('/123numeric')).toBeNull();
    });

    it('handles multiline arguments', () => {
      const router = createRouter();
      const result = router.parse('/msg line1\nline2\nline3');
      expect(result).toEqual({ command: 'msg', args: 'line1\nline2\nline3' });
    });
  });

  // ── Registration & routing ──────────────────────────────

  describe('route', () => {
    it('routes to registered handler', async () => {
      const router = createRouter();
      const handled: CommandContext[] = [];

      router.register('status', async (ctx) => {
        handled.push(ctx);
        return true;
      });

      const result = await router.route('/status', '100', 'user-1');
      expect(result).toBe(true);
      expect(handled).toHaveLength(1);
      expect(handled[0].command).toBe('status');
      expect(handled[0].channelId).toBe('100');
      expect(handled[0].userId).toBe('user-1');
    });

    it('routes with arguments', async () => {
      const router = createRouter();
      const args: string[] = [];

      router.register('claim', async (ctx) => {
        args.push(ctx.args);
        return true;
      });

      await router.route('/claim my-session', '100', 'user-1');
      expect(args).toEqual(['my-session']);
    });

    it('supports command aliases', async () => {
      const router = createRouter();
      let count = 0;

      router.register(['switch-account', 'sa'], async () => {
        count++;
        return true;
      });

      await router.route('/switch-account dawn', '100', 'user-1');
      await router.route('/sa dawn', '100', 'user-1');
      expect(count).toBe(2);
    });

    it('returns false for unregistered commands', async () => {
      const router = createRouter();
      const result = await router.route('/unknown', '100', 'user-1');
      expect(result).toBe(false);
    });

    it('returns false for non-command text', async () => {
      const router = createRouter();
      router.register('status', async () => true);

      const result = await router.route('hello world', '100', 'user-1');
      expect(result).toBe(false);
    });

    it('passes metadata through to handler', async () => {
      const router = createRouter();
      let receivedMeta: Record<string, unknown> | undefined;

      router.register('test', async (ctx) => {
        receivedMeta = ctx.metadata;
        return true;
      });

      await router.route('/test', '100', 'user-1', { telegramUserId: 42 });
      expect(receivedMeta).toEqual({ telegramUserId: 42 });
    });

    it('stops at first handler that returns true', async () => {
      const router = createRouter();
      const order: number[] = [];

      router.register('test', async () => { order.push(1); return true; });
      router.register('test', async () => { order.push(2); return true; });

      await router.route('/test', '100', 'user-1');
      expect(order).toEqual([1]); // Second handler never called
    });

    it('continues to next handler when handler returns false', async () => {
      const router = createRouter();
      const order: number[] = [];

      router.register('test', async () => { order.push(1); return false; });
      router.register('test', async () => { order.push(2); return true; });

      await router.route('/test', '100', 'user-1');
      expect(order).toEqual([1, 2]);
    });

    it('handles handler errors gracefully', async () => {
      const router = createRouter();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      router.register('crash', async () => {
        throw new Error('handler boom');
      });

      const result = await router.route('/crash', '100', 'user-1');
      expect(result).toBe(false); // Error = not handled
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Command /crash error'),
      );

      consoleSpy.mockRestore();
    });
  });

  // ── Platform restrictions ──────────────────────────────

  describe('platform restrictions', () => {
    it('only routes to commands matching current platform', async () => {
      const router = createRouter('whatsapp');
      let telegramHit = false;
      let whatsappHit = false;

      router.register('sessions', async () => { telegramHit = true; return true; }, {
        platforms: ['telegram'],
      });
      router.register('status', async () => { whatsappHit = true; return true; }, {
        platforms: ['whatsapp', 'telegram'],
      });

      await router.route('/sessions', '100', 'user-1');
      expect(telegramHit).toBe(false); // Telegram-only, won't run on WhatsApp

      await router.route('/status', '100', 'user-1');
      expect(whatsappHit).toBe(true); // Multi-platform, runs on WhatsApp
    });

    it('routes unrestricted commands on any platform', async () => {
      const router = createRouter('whatsapp');
      let hit = false;

      router.register('help', async () => { hit = true; return true; });
      // No platforms restriction = runs everywhere

      await router.route('/help', '100', 'user-1');
      expect(hit).toBe(true);
    });
  });

  // ── Interceptors ──────────────────────────────────────

  describe('interceptors', () => {
    it('runs interceptors before command handlers', async () => {
      const router = createRouter();
      const order: string[] = [];

      router.addInterceptor(async () => { order.push('interceptor'); return false; });
      router.register('test', async () => { order.push('handler'); return true; });

      await router.route('/test', '100', 'user-1');
      expect(order).toEqual(['interceptor', 'handler']);
    });

    it('short-circuits when interceptor returns true', async () => {
      const router = createRouter();
      let handlerCalled = false;

      router.addInterceptor(async () => true);
      router.register('test', async () => { handlerCalled = true; return true; });

      const result = await router.route('/test', '100', 'user-1');
      expect(result).toBe(true);
      expect(handlerCalled).toBe(false);
    });

    it('handles interceptor errors gracefully', async () => {
      const router = createRouter();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let handlerCalled = false;

      router.addInterceptor(async () => { throw new Error('interceptor boom'); });
      router.register('test', async () => { handlerCalled = true; return true; });

      await router.route('/test', '100', 'user-1');
      expect(handlerCalled).toBe(true); // Continues to handler after interceptor error
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('runs multiple interceptors in order', async () => {
      const router = createRouter();
      const order: number[] = [];

      router.addInterceptor(async () => { order.push(1); return false; });
      router.addInterceptor(async () => { order.push(2); return false; });
      router.register('test', async () => { order.push(3); return true; });

      await router.route('/test', '100', 'user-1');
      expect(order).toEqual([1, 2, 3]);
    });
  });

  // ── Help generation ──────────────────────────────────────

  describe('generateHelp', () => {
    it('lists all registered commands', () => {
      const router = createRouter();
      router.register('status', async () => true, { description: 'Show adapter status' });
      router.register(['switch-account', 'sa'], async () => true, { description: 'Switch Claude account' });
      router.register('help', async () => true);

      const help = router.generateHelp();
      expect(help).toContain('/status');
      expect(help).toContain('Show adapter status');
      expect(help).toContain('/switch-account');
      expect(help).toContain('/sa');
      expect(help).toContain('/help');
    });

    it('excludes commands for other platforms', () => {
      const router = createRouter('whatsapp');
      router.register('sessions', async () => true, {
        description: 'List sessions',
        platforms: ['telegram'],
      });
      router.register('status', async () => true, { description: 'Show status' });

      const help = router.generateHelp();
      expect(help).not.toContain('/sessions');
      expect(help).toContain('/status');
    });

    it('returns message when no commands registered', () => {
      const router = createRouter();
      expect(router.generateHelp()).toBe('No commands available.');
    });
  });

  // ── getRegisteredCommands ──────────────────────────────

  describe('getRegisteredCommands', () => {
    it('returns command info for current platform', () => {
      const router = createRouter('telegram');
      router.register('status', async () => true, { description: 'Status' });
      router.register('wa-only', async () => true, { platforms: ['whatsapp'] });

      const cmds = router.getRegisteredCommands();
      expect(cmds).toHaveLength(1);
      expect(cmds[0].names).toEqual(['status']);
    });
  });

  // ── Edge cases ──────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty command list gracefully', async () => {
      const router = createRouter();
      const result = await router.route('/anything', '100', 'user-1');
      expect(result).toBe(false);
    });

    it('handles register with slash prefix in name', () => {
      const router = createRouter();
      let hit = false;
      router.register('/status', async () => { hit = true; return true; });

      // Should still work — slash is stripped
      router.route('/status', '100', 'user-1');
    });

    it('handles concurrent route calls', async () => {
      const router = createRouter();
      let count = 0;

      router.register('test', async () => {
        count++;
        await new Promise(r => setTimeout(r, 10));
        return true;
      });

      // Fire multiple routes concurrently
      await Promise.all([
        router.route('/test', '1', 'u1'),
        router.route('/test', '2', 'u2'),
        router.route('/test', '3', 'u3'),
      ]);
      expect(count).toBe(3);
    });

    it('rawText preserves original text exactly', async () => {
      const router = createRouter();
      let raw: string | undefined;

      router.register('test', async (ctx) => { raw = ctx.rawText; return true; });
      await router.route('/Test  Hello World', '100', 'user-1');
      expect(raw).toBe('/Test  Hello World');
    });
  });
});
