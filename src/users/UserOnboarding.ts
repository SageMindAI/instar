/**
 * User Onboarding — handles new user registration and verification flows.
 *
 * Implements the Multi-User Setup Wizard spec (Rev 7):
 * - New user joining an existing agent
 * - Existing user on a new machine (verification)
 * - On-the-fly Telegram registration
 * - Consent collection before data collection
 * - Agent contextual assessment for join requests
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  UserProfile,
  UserChannel,
  AgentAutonomyConfig,
  UserRegistrationPolicy,
  ConsentRecord,
  DataCollectedManifest,
  VerificationCode,
  JoinRequest,
  OnboardingConfig,
  OnboardingQuestion,
} from '../core/types.js';
import { UserManager } from './UserManager.js';

// ── Constants ────────────────────────────────────────────────────────

const VERIFICATION_DEFAULTS = {
  digits: 6,
  expiryMinutes: 10,
  maxAttempts: 5,
  lockoutMinutes: 30,
} as const;

const CONNECT_CODE_DEFAULTS = {
  length: 8,
  expiryMinutes: 15,
} as const;

// Unambiguous character set (no 0/O, 1/l/I)
const UNAMBIGUOUS_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

// ── Code Generation ──────────────────────────────────────────────────

/**
 * Generate a random numeric verification code.
 */
export function generateVerificationCode(digits: number = VERIFICATION_DEFAULTS.digits): string {
  const max = Math.pow(10, digits);
  const min = Math.pow(10, digits - 1);
  const num = crypto.randomInt(min, max);
  return num.toString();
}

/**
 * Generate a cryptographically random alphanumeric connect code
 * using unambiguous characters (no 0/O, 1/l/I).
 */
export function generateConnectCode(length: number = CONNECT_CODE_DEFAULTS.length): string {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i++) {
    code += UNAMBIGUOUS_CHARS[bytes[i] % UNAMBIGUOUS_CHARS.length];
  }
  return code;
}

/**
 * Hash a verification code for storage (we never store plaintext codes).
 */
export function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Generate a recovery key (32 bytes, displayed as hex).
 */
export function generateRecoveryKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a recovery key with bcrypt-compatible SHA-256 (for config storage).
 */
export function hashRecoveryKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// ── Consent ──────────────────────────────────────────────────────────

/**
 * Build the consent disclosure text for a given agent name.
 * If onboardingConfig.consentDisclosure is provided, uses that instead.
 */
export function buildConsentDisclosure(agentName: string, onboardingConfig?: OnboardingConfig): string {
  if (onboardingConfig?.consentDisclosure) {
    return onboardingConfig.consentDisclosure;
  }

  return [
    `Before we get started, here's what ${agentName} stores about you:`,
    `- Your name and communication preferences`,
    `- Your Telegram user ID (for identity verification)`,
    `- Conversation history within your personal topic`,
    `- Memory entries created during your sessions (tagged with your user ID)`,
    ``,
    `You can request deletion of your data at any time by asking the agent`,
    `or contacting the admin. Your data is stored locally on the machines`,
    `running this agent and in the git-backed state repository (if enabled).`,
  ].join('\n');
}

/**
 * Build a condensed consent disclosure for on-the-fly Telegram registration.
 */
export function buildCondensedConsentDisclosure(agentName: string): string {
  return `${agentName} will store your name, Telegram ID, and conversation history. You can request deletion anytime. Reply "OK" to continue or "No thanks" to stop.`;
}

/**
 * Create a consent record.
 */
export function createConsentRecord(version?: string): ConsentRecord {
  return {
    consentGiven: true,
    consentDate: new Date().toISOString(),
    consentNoticeVersion: version,
  };
}

/**
 * Create a default data collected manifest.
 */
export function createDataManifest(options?: Partial<DataCollectedManifest>): DataCollectedManifest {
  return {
    name: true,
    telegramId: false,
    communicationPreferences: true,
    conversationHistory: false,
    memoryEntries: false,
    machineIdentities: false,
    ...options,
  };
}

// ── Verification ─────────────────────────────────────────────────────

/**
 * Manages verification codes with expiry and attempt limits.
 */
export class VerificationManager {
  private codes: Map<string, VerificationCode> = new Map();
  private lockouts: Map<string, number> = new Map(); // userId -> lockout expiry timestamp

  /**
   * Create a new verification code for a target.
   * Returns the plaintext code (display to user) and stores the hash.
   */
  createCode(targetId: string, type: VerificationCode['type']): { code: string; expiresAt: Date } {
    // Check lockout
    const lockoutExpiry = this.lockouts.get(targetId);
    if (lockoutExpiry && Date.now() < lockoutExpiry) {
      const remainingMinutes = Math.ceil((lockoutExpiry - Date.now()) / 60000);
      throw new Error(`Too many failed attempts. Please wait ${remainingMinutes} minutes.`);
    }

    const code = type === 'pairing-code'
      ? generateConnectCode()
      : generateVerificationCode();

    const expiryMinutes = type === 'pairing-code'
      ? CONNECT_CODE_DEFAULTS.expiryMinutes
      : VERIFICATION_DEFAULTS.expiryMinutes;

    const verificationCode: VerificationCode = {
      codeHash: hashCode(code),
      createdAt: new Date().toISOString(),
      expiryMinutes,
      maxAttempts: VERIFICATION_DEFAULTS.maxAttempts,
      attempts: 0,
      used: false,
      targetId,
      type,
    };

    this.codes.set(targetId, verificationCode);
    const expiresAt = new Date(Date.now() + expiryMinutes * 60000);

    return { code, expiresAt };
  }

  /**
   * Verify a code attempt. Returns true if valid.
   * Handles attempt counting, expiry, and lockout.
   */
  verifyCode(targetId: string, attempt: string): { valid: boolean; error?: string } {
    const stored = this.codes.get(targetId);

    if (!stored) {
      return { valid: false, error: 'No verification code found. Please request a new one.' };
    }

    // Check expiry
    const expiryTime = new Date(stored.createdAt).getTime() + stored.expiryMinutes * 60000;
    if (Date.now() > expiryTime) {
      this.codes.delete(targetId);
      return { valid: false, error: 'Code has expired. Please request a new one.' };
    }

    // Check if already used
    if (stored.used) {
      return { valid: false, error: 'Code has already been used. Please request a new one.' };
    }

    // Increment attempts
    stored.attempts++;

    // Check attempt limit
    if (stored.attempts > stored.maxAttempts) {
      this.codes.delete(targetId);
      // Set lockout
      this.lockouts.set(targetId, Date.now() + VERIFICATION_DEFAULTS.lockoutMinutes * 60000);
      return {
        valid: false,
        error: `Too many incorrect attempts. Please wait ${VERIFICATION_DEFAULTS.lockoutMinutes} minutes before requesting a new code.`,
      };
    }

    // Verify
    if (hashCode(attempt) === stored.codeHash) {
      stored.used = true;
      this.codes.delete(targetId);
      return { valid: true };
    }

    const remaining = stored.maxAttempts - stored.attempts;
    return {
      valid: false,
      error: `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
    };
  }
}

// ── Join Request Management ──────────────────────────────────────────

/**
 * Manages join requests for admin-only registration.
 */
export class JoinRequestManager {
  private requests: Map<string, JoinRequest> = new Map();
  private requestsFile: string;

  constructor(stateDir: string) {
    this.requestsFile = path.join(stateDir, 'join-requests.json');
    this.loadRequests();
  }

  /**
   * Create a new join request.
   */
  createRequest(name: string, telegramUserId: number, agentAssessment: string | null): JoinRequest {
    const requestId = crypto.randomBytes(8).toString('hex');
    const approvalCode = crypto.randomBytes(3).toString('hex'); // 6-char hex

    const request: JoinRequest = {
      requestId,
      name,
      telegramUserId,
      agentAssessment,
      approvalCode,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    };

    this.requests.set(requestId, request);
    this.persistRequests();
    return request;
  }

  /**
   * Resolve a join request (approve or deny).
   */
  resolveRequest(approvalCode: string, action: 'approved' | 'denied', resolvedBy: string): JoinRequest | null {
    for (const request of this.requests.values()) {
      if (request.approvalCode === approvalCode && request.status === 'pending') {
        request.status = action;
        request.resolvedBy = resolvedBy;
        request.resolvedAt = new Date().toISOString();
        this.persistRequests();
        return request;
      }
    }
    return null;
  }

  /**
   * Get pending requests.
   */
  getPendingRequests(): JoinRequest[] {
    return Array.from(this.requests.values()).filter(r => r.status === 'pending');
  }

  /**
   * Get a request by Telegram user ID.
   */
  getRequestByTelegramUser(telegramUserId: number): JoinRequest | null {
    for (const request of this.requests.values()) {
      if (request.telegramUserId === telegramUserId && request.status === 'pending') {
        return request;
      }
    }
    return null;
  }

  private loadRequests(): void {
    if (fs.existsSync(this.requestsFile)) {
      try {
        const data: JoinRequest[] = JSON.parse(fs.readFileSync(this.requestsFile, 'utf-8'));
        for (const req of data) {
          this.requests.set(req.requestId, req);
        }
      } catch {
        // Start fresh on corruption
      }
    }
  }

  private persistRequests(): void {
    const dir = path.dirname(this.requestsFile);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.requestsFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(Array.from(this.requests.values()), null, 2));
      fs.renameSync(tmpPath, this.requestsFile);
    } catch (err) {
      // safe-git-allow: incremental-migration
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}

// ── Onboarding Flow ──────────────────────────────────────────────────

/**
 * Build a new user profile from onboarding data.
 * Supports both minimal onboarding (name + consent) and rich onboarding
 * (bio, interests, timezone, relationship context, custom fields).
 */
export function buildUserProfile(opts: {
  name: string;
  userId?: string;
  telegramTopicId?: string;
  telegramUserId?: number;
  email?: string;
  permissions?: string[];
  style?: string;
  autonomyLevel?: 'full' | 'confirm-destructive' | 'confirm-all';
  consent?: ConsentRecord;
  // ── Rich onboarding fields (Phase 3) ──
  bio?: string;
  interests?: string[];
  timezone?: string;
  relationshipContext?: string;
  customFields?: Record<string, string>;
}): UserProfile {
  // Generate a URL-safe user ID from the name if not provided
  const userId = opts.userId || opts.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || `user-${crypto.randomBytes(4).toString('hex')}`;

  const channels: UserChannel[] = [];
  if (opts.telegramTopicId) {
    channels.push({ type: 'telegram', identifier: opts.telegramTopicId });
  }
  if (opts.email) {
    channels.push({ type: 'email', identifier: opts.email });
  }

  const profile: UserProfile = {
    id: userId,
    name: opts.name,
    channels,
    permissions: opts.permissions || ['user'],
    preferences: {
      style: opts.style,
      autonomyLevel: opts.autonomyLevel || 'confirm-destructive',
      timezone: opts.timezone,
    },
    consent: opts.consent,
    dataCollected: createDataManifest({
      telegramId: !!opts.telegramTopicId || !!opts.telegramUserId,
      conversationHistory: !!opts.telegramTopicId,
      communicationPreferences: !!(opts.style || opts.timezone),
    }),
    pendingTelegramTopic: false,
    createdAt: new Date().toISOString(),
    telegramUserId: opts.telegramUserId,
  };

  // Rich onboarding fields — only set if provided
  if (opts.bio !== undefined) profile.bio = opts.bio;
  if (opts.interests !== undefined) profile.interests = opts.interests;
  if (opts.relationshipContext !== undefined) profile.relationshipContext = opts.relationshipContext;
  if (opts.customFields !== undefined) profile.customFields = opts.customFields;

  return profile;
}

/**
 * Get the list of onboarding prompts for a given OnboardingConfig.
 * Returns an ordered list of questions the onboarding flow should ask.
 * Only includes questions for fields the agent has configured.
 */
export function getOnboardingPrompts(config: OnboardingConfig): Array<{
  fieldName: string;
  prompt: string;
  required: boolean;
  type: 'builtin' | 'custom';
}> {
  const prompts: Array<{
    fieldName: string;
    prompt: string;
    required: boolean;
    type: 'builtin' | 'custom';
  }> = [];

  if (config.collectBio) {
    prompts.push({
      fieldName: 'bio',
      prompt: 'Tell me a bit about yourself (optional — a sentence or two is fine):',
      required: false,
      type: 'builtin',
    });
  }

  if (config.collectInterests) {
    prompts.push({
      fieldName: 'interests',
      prompt: 'What topics or areas are you interested in? (comma-separated, optional):',
      required: false,
      type: 'builtin',
    });
  }

  if (config.collectTimezone) {
    prompts.push({
      fieldName: 'timezone',
      prompt: 'What timezone are you in? (e.g., America/New_York, Europe/London):',
      required: false,
      type: 'builtin',
    });
  }

  if (config.collectStyle) {
    prompts.push({
      fieldName: 'style',
      prompt: 'How do you prefer communication? (e.g., "technical and direct", "friendly and detailed"):',
      required: false,
      type: 'builtin',
    });
  }

  if (config.collectRelationshipContext) {
    prompts.push({
      fieldName: 'relationshipContext',
      prompt: 'How do you relate to this project? (e.g., "developer", "beta tester", "curious observer"):',
      required: false,
      type: 'builtin',
    });
  }

  // Custom questions from agent config
  if (config.customQuestions) {
    for (const q of config.customQuestions) {
      prompts.push({
        fieldName: q.fieldName,
        prompt: q.prompt,
        required: q.required ?? false,
        type: 'custom',
      });
    }
  }

  return prompts;
}

/**
 * Parse a comma-separated interest string into an array.
 * Trims whitespace, removes empty entries.
 */
export function parseInterests(input: string): string[] {
  return input
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/**
 * Apply rich onboarding answers to an existing UserProfile.
 * Used when onboarding is collected in stages (e.g., Telegram multi-step flow).
 */
export function applyOnboardingAnswers(
  profile: UserProfile,
  answers: Record<string, string>,
  config: OnboardingConfig,
): UserProfile {
  const updated = { ...profile };

  // Built-in fields
  if ('bio' in answers && config.collectBio) {
    updated.bio = answers.bio;
  }
  if ('interests' in answers && config.collectInterests) {
    updated.interests = parseInterests(answers.interests);
  }
  if ('timezone' in answers && config.collectTimezone) {
    updated.preferences = { ...updated.preferences, timezone: answers.timezone };
  }
  if ('style' in answers && config.collectStyle) {
    updated.preferences = { ...updated.preferences, style: answers.style };
  }
  if ('relationshipContext' in answers && config.collectRelationshipContext) {
    updated.relationshipContext = answers.relationshipContext;
  }

  // Custom fields — only accept fields defined in config
  if (config.customQuestions) {
    const customFields = { ...updated.customFields };
    for (const q of config.customQuestions) {
      if (q.fieldName in answers) {
        customFields[q.fieldName] = answers[q.fieldName];
      }
    }
    if (Object.keys(customFields).length > 0) {
      updated.customFields = customFields;
    }
  }

  return updated;
}

/**
 * Get the default autonomy config for a given level.
 */
export function getDefaultAutonomyConfig(level: AgentAutonomyConfig['level']): AgentAutonomyConfig {
  switch (level) {
    case 'supervised':
      return {
        level: 'supervised',
        capabilities: {
          assessJoinRequests: false,
          proposeConflictResolution: false,
          recommendConfigChanges: false,
          autoEnableVerifiedJobs: false,
          proactiveStatusAlerts: false,
          autoApproveKnownContacts: false,
        },
      };
    case 'collaborative':
      return {
        level: 'collaborative',
        capabilities: {
          assessJoinRequests: true,
          proposeConflictResolution: true,
          recommendConfigChanges: true,
          autoEnableVerifiedJobs: false,
          proactiveStatusAlerts: true,
          autoApproveKnownContacts: false,
        },
      };
    case 'autonomous':
      return {
        level: 'autonomous',
        capabilities: {
          assessJoinRequests: true,
          proposeConflictResolution: true,
          recommendConfigChanges: true,
          autoEnableVerifiedJobs: true,
          proactiveStatusAlerts: true,
          autoApproveKnownContacts: true,
        },
      };
  }
}
