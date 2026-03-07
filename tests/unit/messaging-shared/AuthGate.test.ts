import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthGate, type UnknownUserInfo, type AuthGateCallbacks } from '../../../src/messaging/shared/AuthGate.js';

describe('AuthGate', () => {
  function makeUserInfo(overrides: Partial<UnknownUserInfo> = {}): UnknownUserInfo {
    return {
      userId: '12345',
      displayName: 'Test User',
      username: 'testuser',
      ...overrides,
    };
  }

  function makeCallbacks(overrides: Partial<AuthGateCallbacks> = {}): AuthGateCallbacks & { sent: string[] } {
    const sent: string[] = [];
    return {
      sent,
      sendResponse: async (msg) => { sent.push(msg); },
      ...overrides,
    };
  }

  // ── Authorization ──────────────────────────────────────

  describe('isAuthorized', () => {
    it('allows all users when no authorized list is set', () => {
      const gate = new AuthGate({ authorizedUsers: [] });
      expect(gate.isAuthorized('anyone')).toBe(true);
      expect(gate.isAuthorized('12345')).toBe(true);
    });

    it('allows authorized users', () => {
      const gate = new AuthGate({ authorizedUsers: ['100', '200'] });
      expect(gate.isAuthorized('100')).toBe(true);
      expect(gate.isAuthorized('200')).toBe(true);
    });

    it('rejects unauthorized users', () => {
      const gate = new AuthGate({ authorizedUsers: ['100'] });
      expect(gate.isAuthorized('999')).toBe(false);
    });

    it('handles numeric IDs as strings', () => {
      const gate = new AuthGate({ authorizedUsers: ['12345678'] });
      expect(gate.isAuthorized('12345678')).toBe(true);
      expect(gate.isAuthorized(12345678 as unknown as string)).toBe(true);
    });
  });

  describe('check', () => {
    it('returns authorized result for known users', () => {
      const gate = new AuthGate({ authorizedUsers: ['100'] });
      const result = gate.check('100', makeUserInfo());
      expect(result.authorized).toBe(true);
    });

    it('returns unauthorized result with user info for unknown users', () => {
      const gate = new AuthGate({ authorizedUsers: ['100'] });
      const userInfo = makeUserInfo({ userId: '999', displayName: 'Stranger' });
      const result = gate.check('999', userInfo);
      expect(result.authorized).toBe(false);
      if (!result.authorized) {
        expect(result.reason).toBe('not-authorized');
        expect(result.userInfo.displayName).toBe('Stranger');
      }
    });
  });

  // ── Runtime authorize/deauthorize ──────────────────────

  describe('authorize / deauthorize', () => {
    it('dynamically adds authorized users', () => {
      const gate = new AuthGate({ authorizedUsers: ['100'] });
      expect(gate.isAuthorized('200')).toBe(false);
      gate.authorize('200');
      expect(gate.isAuthorized('200')).toBe(true);
    });

    it('dynamically removes authorized users', () => {
      const gate = new AuthGate({ authorizedUsers: ['100', '200'] });
      expect(gate.isAuthorized('200')).toBe(true);
      gate.deauthorize('200');
      expect(gate.isAuthorized('200')).toBe(false);
    });

    it('reports correct authorized count', () => {
      const gate = new AuthGate({ authorizedUsers: ['100', '200'] });
      expect(gate.authorizedCount).toBe(2);
      gate.authorize('300');
      expect(gate.authorizedCount).toBe(3);
      gate.deauthorize('100');
      expect(gate.authorizedCount).toBe(2);
    });
  });

  // ── Policy ──────────────────────────────────────────

  describe('getPolicy / setPolicy', () => {
    it('returns current policy', () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'admin-only', agentName: 'MyBot' },
      });
      const policy = gate.getPolicy();
      expect(policy.policy).toBe('admin-only');
      expect(policy.agentName).toBe('MyBot');
    });

    it('defaults to closed policy', () => {
      const gate = new AuthGate({ authorizedUsers: [] });
      expect(gate.getPolicy().policy).toBe('closed');
    });

    it('updates policy at runtime', () => {
      const gate = new AuthGate({ authorizedUsers: [] });
      gate.setPolicy({ policy: 'open', agentName: 'NewBot' });
      expect(gate.getPolicy().policy).toBe('open');
      expect(gate.getPolicy().agentName).toBe('NewBot');
    });

    it('returns a copy (not a reference)', () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'admin-only' },
      });
      const policy = gate.getPolicy();
      policy.policy = 'open'; // Mutate the copy
      expect(gate.getPolicy().policy).toBe('admin-only'); // Original unchanged
    });
  });

  // ── handleUnauthorized — admin-only ──────────────────

  describe('handleUnauthorized — admin-only', () => {
    it('sends gated message and notifies admin', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'admin-only', agentName: 'MyBot' },
      });
      const callbacks = makeCallbacks({
        notifyAdmin: vi.fn().mockResolvedValue(undefined),
      });

      const result = await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(result).toBe(true);
      expect(callbacks.sent).toHaveLength(1);
      expect(callbacks.sent[0]).toContain('MyBot');
      expect(callbacks.sent[0]).toContain('not open for public registration');
      expect(callbacks.sent[0]).toContain('forwarded to the admin');
      expect(callbacks.notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({
        userId: '12345',
        displayName: 'Test User',
      }));
    });

    it('includes contact hint when set', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: {
          policy: 'admin-only',
          contactHint: 'Email admin@example.com for access.',
        },
      });
      const callbacks = makeCallbacks();
      await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(callbacks.sent[0]).toContain('Email admin@example.com for access.');
    });

    it('handles missing notifyAdmin callback gracefully', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'admin-only' },
      });
      const callbacks = makeCallbacks(); // No notifyAdmin
      const result = await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(result).toBe(true);
      expect(callbacks.sent).toHaveLength(1);
    });
  });

  // ── handleUnauthorized — invite-only ──────────────────

  describe('handleUnauthorized — invite-only', () => {
    it('prompts for invite code when no code provided', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'invite-only', agentName: 'InviteBot' },
      });
      const callbacks = makeCallbacks();
      await gate.handleUnauthorized(makeUserInfo({ messageText: 'hello' }), callbacks);
      // Without validateInviteCode callback, just shows the prompt
      expect(callbacks.sent[0]).toContain('requires an invite code');
    });

    it('accepts valid invite code and starts onboarding', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'invite-only' },
      });
      const onboarded: string[] = [];
      const callbacks = makeCallbacks({
        validateInviteCode: vi.fn().mockResolvedValue({ valid: true }),
        startOnboarding: async (userId) => { onboarded.push(userId); },
      });

      await gate.handleUnauthorized(makeUserInfo({ messageText: 'XKRT4M2N' }), callbacks);
      expect(callbacks.sent[0]).toContain('accepted');
      expect(onboarded).toEqual(['12345']);
    });

    it('shows error for invalid invite code', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'invite-only' },
      });
      const callbacks = makeCallbacks({
        validateInviteCode: vi.fn().mockResolvedValue({
          valid: false,
          error: 'Invalid or expired invite code.',
        }),
      });

      await gate.handleUnauthorized(makeUserInfo({ messageText: 'BADCODE' }), callbacks);
      expect(callbacks.sent[0]).toBe('Invalid or expired invite code.');
    });

    it('includes contact hint when set', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: {
          policy: 'invite-only',
          contactHint: 'DM @admin for an invite.',
        },
      });
      const callbacks = makeCallbacks();
      await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(callbacks.sent[0]).toContain('DM @admin for an invite.');
    });
  });

  // ── handleUnauthorized — open ──────────────────────

  describe('handleUnauthorized — open', () => {
    it('sends welcome and starts onboarding', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'open' },
      });
      const onboarded: Array<{ userId: string; name: string; username?: string }> = [];
      const callbacks = makeCallbacks({
        startOnboarding: async (userId, name, username) => {
          onboarded.push({ userId, name, username });
        },
      });

      await gate.handleUnauthorized(makeUserInfo({ displayName: 'NewUser' }), callbacks);
      expect(callbacks.sent[0]).toContain('Welcome');
      expect(onboarded).toHaveLength(1);
      expect(onboarded[0].name).toBe('NewUser');
    });

    it('handles missing onboarding callback', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'open' },
      });
      const callbacks = makeCallbacks();
      await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(callbacks.sent[0]).toContain('being set up');
    });

    it('handles onboarding errors gracefully', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'open' },
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const callbacks = makeCallbacks({
        startOnboarding: async () => { throw new Error('onboard boom'); },
      });

      await gate.handleUnauthorized(makeUserInfo(), callbacks);
      // Should send error recovery message
      expect(callbacks.sent.length).toBeGreaterThanOrEqual(1);
      consoleSpy.mockRestore();
    });
  });

  // ── handleUnauthorized — closed ──────────────────────

  describe('handleUnauthorized — closed', () => {
    it('sends rejection message', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'closed', agentName: 'ClosedBot' },
      });
      const callbacks = makeCallbacks();
      await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(callbacks.sent[0]).toContain('not currently accepting new users');
    });
  });

  // ── Rate limiting ──────────────────────────────────────

  describe('rate limiting', () => {
    it('rate-limits responses to the same user', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'closed' },
      });
      const callbacks = makeCallbacks();

      // First call succeeds
      const result1 = await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(result1).toBe(true);
      expect(callbacks.sent).toHaveLength(1);

      // Second call within cooldown is rate-limited
      const result2 = await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(result2).toBe(false);
      expect(callbacks.sent).toHaveLength(1); // No new message
    });

    it('allows response to different users', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'closed' },
      });
      const callbacks = makeCallbacks();

      await gate.handleUnauthorized(makeUserInfo({ userId: '111' }), callbacks);
      await gate.handleUnauthorized(makeUserInfo({ userId: '222' }), callbacks);
      expect(callbacks.sent).toHaveLength(2);
    });
  });

  // ── Error handling ──────────────────────────────────────

  describe('error handling', () => {
    it('handles sendResponse errors gracefully', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'closed' },
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const callbacks: AuthGateCallbacks = {
        sendResponse: async () => { throw new Error('send boom'); },
      };

      const result = await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(result).toBe(false); // Error = not handled
      consoleSpy.mockRestore();
    });

    it('handles notifyAdmin errors without failing the response', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'admin-only' },
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const callbacks = makeCallbacks({
        notifyAdmin: async () => { throw new Error('notify boom'); },
      });

      const result = await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(result).toBe(true); // User still got a response
      expect(callbacks.sent).toHaveLength(1);
      consoleSpy.mockRestore();
    });
  });

  // ── Edge cases ──────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty messageText for invite-only', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'invite-only' },
      });
      const callbacks = makeCallbacks({
        validateInviteCode: vi.fn(),
      });

      await gate.handleUnauthorized(makeUserInfo({ messageText: '' }), callbacks);
      expect(callbacks.validateInviteCode).not.toHaveBeenCalled();
      expect(callbacks.sent[0]).toContain('invite code');
    });

    it('handles undefined messageText for invite-only', async () => {
      const gate = new AuthGate({
        authorizedUsers: [],
        registrationPolicy: { policy: 'invite-only' },
      });
      const callbacks = makeCallbacks({
        validateInviteCode: vi.fn(),
      });

      await gate.handleUnauthorized(makeUserInfo({ messageText: undefined }), callbacks);
      expect(callbacks.validateInviteCode).not.toHaveBeenCalled();
    });

    it('uses default agent name when not configured', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'admin-only' }, // No agentName
      });
      const callbacks = makeCallbacks();
      await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(callbacks.sent[0]).toContain('This agent');
    });

    it('handles unknown policy gracefully', async () => {
      const gate = new AuthGate({
        authorizedUsers: ['100'],
        registrationPolicy: { policy: 'unknown-future-policy' as any },
      });
      const callbacks = makeCallbacks();
      await gate.handleUnauthorized(makeUserInfo(), callbacks);
      expect(callbacks.sent[0]).toContain('not currently accepting');
    });
  });
});
