/**
 * Job Loader — read and validate job definitions from a JSON file.
 *
 * Jobs define recurring work the agent should perform:
 * email checks, health probes, content publishing, etc.
 *
 * Grounding-by-default: Jobs are validated for grounding configuration.
 * Missing grounding emits warnings — nudging the practice without breaking
 * existing jobs. Jobs that process external input WITHOUT grounding get
 * louder warnings because they represent a security surface.
 */

import fs from 'node:fs';
import { Cron } from 'croner';
import type { JobDefinition, JobPriority, ModelTier } from '../core/types.js';

const VALID_PRIORITIES: JobPriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_MODELS: ModelTier[] = ['opus', 'sonnet', 'haiku'];

/** Slugs for lightweight default jobs where grounding is unnecessary. */
const GROUNDING_EXEMPT_SLUGS: ReadonlySet<string> = new Set([
  'health-check',
  'feedback-retry',
  'dispatch-check',
  'update-check',
  'project-map-refresh',
  'git-sync',
]);

/**
 * Load and validate job definitions from a JSON file.
 * Throws on invalid structure — fail loud at startup, not at runtime.
 *
 * Missing file is NOT fatal: treated as "no jobs configured" so a
 * fresh or partially-initialized agent still boots. The scheduler
 * handles an empty list correctly.
 */
export function loadJobs(jobsFile: string): JobDefinition[] {
  if (!fs.existsSync(jobsFile)) {
    console.warn(
      `[JobLoader] Jobs file not found: ${jobsFile} — treating as empty job list. ` +
      `Create the file to configure recurring jobs.`
    );
    return [];
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse jobs file ${jobsFile}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!Array.isArray(raw)) {
    throw new Error(`Jobs file must contain a JSON array, got ${typeof raw}`);
  }

  const jobs = raw.map((job: unknown, index: number) => {
    validateJob(job, index);
    return job as JobDefinition;
  });

  // Grounding-by-default audit — warn about jobs missing grounding config
  auditGrounding(jobs);

  return jobs;
}

/**
 * Validate a single job definition.
 * Throws with a descriptive message on any issue.
 */
export function validateJob(job: unknown, index?: number): void {
  const prefix = index !== undefined ? `Job[${index}]` : 'Job';

  if (!job || typeof job !== 'object') {
    throw new Error(`${prefix}: must be an object`);
  }

  const j = job as Record<string, unknown>;

  // Required string fields
  for (const field of ['slug', 'name', 'description', 'schedule']) {
    if (typeof j[field] !== 'string' || !(j[field] as string).trim()) {
      throw new Error(`${prefix}: "${field}" is required and must be a non-empty string`);
    }
  }

  // Slug format — used in file paths and URLs, must be safe
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(j.slug as string)) {
    throw new Error(`${prefix}: "slug" must contain only letters, numbers, hyphens, underscores (max 100 chars)`);
  }

  // Priority
  if (!VALID_PRIORITIES.includes(j.priority as JobPriority)) {
    throw new Error(
      `${prefix}: "priority" must be one of ${VALID_PRIORITIES.join(', ')}, got "${j.priority}"`
    );
  }

  // Model tier (optional — defaults to the agent's preferred model)
  if (j.model !== undefined && !VALID_MODELS.includes(j.model as ModelTier)) {
    throw new Error(
      `${prefix}: "model" must be one of ${VALID_MODELS.join(', ')}, got "${j.model}"`
    );
  }

  // Cron expression — try to parse it (validate only, don't leave running)
  try {
    const testCron = new Cron(j.schedule as string);
    testCron.stop();
  } catch (err) {
    throw new Error(`${prefix}: invalid cron expression "${j.schedule}": ${err}`);
  }

  // Enabled must be boolean
  if (typeof j.enabled !== 'boolean') {
    throw new Error(`${prefix}: "enabled" must be a boolean`);
  }

  // Execute block
  if (!j.execute || typeof j.execute !== 'object') {
    throw new Error(`${prefix}: "execute" must be an object with type and value`);
  }
  const exec = j.execute as Record<string, unknown>;
  if (!['skill', 'prompt', 'script'].includes(exec.type as string)) {
    throw new Error(`${prefix}: execute.type must be "skill", "prompt", or "script"`);
  }
  if (typeof exec.value !== 'string' || !(exec.value as string).trim()) {
    throw new Error(`${prefix}: execute.value is required`);
  }

  // Optional args must be a string if present
  if (exec.args !== undefined && typeof exec.args !== 'string') {
    throw new Error(`${prefix}: execute.args must be a string if provided, got ${typeof exec.args}`);
  }

  // Optional gate must be a string if present
  if (j.gate !== undefined && typeof j.gate !== 'string') {
    throw new Error(`${prefix}: "gate" must be a string (shell command) if provided, got ${typeof j.gate}`);
  }

  // telegramNotify — boolean or 'on-alert'
  if (j.telegramNotify !== undefined) {
    if (typeof j.telegramNotify !== 'boolean' && j.telegramNotify !== 'on-alert') {
      throw new Error(`${prefix}: "telegramNotify" must be true, false, or "on-alert" if provided, got "${j.telegramNotify}"`);
    }
  }

  // Machine scope — optional array of machine IDs or names
  if (j.machines !== undefined) {
    if (!Array.isArray(j.machines)) {
      throw new Error(`${prefix}: "machines" must be an array of machine IDs or names if provided`);
    }
    for (const m of j.machines) {
      if (typeof m !== 'string' || !m.trim()) {
        throw new Error(`${prefix}: "machines" entries must be non-empty strings`);
      }
    }
  }

  // Grounding config — validate structure if present
  if (j.grounding !== undefined) {
    validateGrounding(j.grounding, prefix);
  }

  // CommonBlockers — validate structure if present
  if (j.commonBlockers !== undefined) {
    validateCommonBlockers(j.commonBlockers, prefix);
  }
}

/**
 * Validate grounding configuration structure.
 * Throws on invalid structure — if you're going to declare grounding, do it right.
 */
function validateGrounding(grounding: unknown, prefix: string): void {
  if (!grounding || typeof grounding !== 'object') {
    throw new Error(`${prefix}: "grounding" must be an object if provided`);
  }

  const g = grounding as Record<string, unknown>;

  if (typeof g.requiresIdentity !== 'boolean') {
    throw new Error(`${prefix}: grounding.requiresIdentity must be a boolean`);
  }

  if (g.processesExternalInput !== undefined && typeof g.processesExternalInput !== 'boolean') {
    throw new Error(`${prefix}: grounding.processesExternalInput must be a boolean if provided`);
  }

  if (g.contextFiles !== undefined) {
    if (!Array.isArray(g.contextFiles)) {
      throw new Error(`${prefix}: grounding.contextFiles must be an array of strings if provided`);
    }
    for (const f of g.contextFiles) {
      if (typeof f !== 'string' || !f.trim()) {
        throw new Error(`${prefix}: grounding.contextFiles entries must be non-empty strings`);
      }
    }
  }

  if (g.questions !== undefined) {
    if (!Array.isArray(g.questions)) {
      throw new Error(`${prefix}: grounding.questions must be an array of strings if provided`);
    }
    for (const q of g.questions) {
      if (typeof q !== 'string' || !q.trim()) {
        throw new Error(`${prefix}: grounding.questions entries must be non-empty strings`);
      }
    }
  }
}

/**
 * Validate commonBlockers configuration structure.
 * CommonBlockers are Record<string, CommonBlocker> — keyed object of pre-confirmed resolutions.
 */
export function validateCommonBlockers(blockers: unknown, prefix: string): void {
  if (!blockers || typeof blockers !== 'object' || Array.isArray(blockers)) {
    throw new Error(`${prefix}: "commonBlockers" must be a plain object (Record<string, CommonBlocker>) if provided`);
  }

  const b = blockers as Record<string, unknown>;
  const keys = Object.keys(b);

  if (keys.length > 20) {
    throw new Error(`${prefix}: "commonBlockers" has ${keys.length} entries, max is 20`);
  }

  for (const key of keys) {
    const entry = b[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${prefix}: commonBlockers["${key}"] must be an object`);
    }

    const e = entry as Record<string, unknown>;

    // Required fields
    if (typeof e.description !== 'string' || !e.description.toString().trim()) {
      throw new Error(`${prefix}: commonBlockers["${key}"] "description" is required and must be a non-empty string`);
    }
    if (typeof e.resolution !== 'string' || !e.resolution.toString().trim()) {
      throw new Error(`${prefix}: commonBlockers["${key}"] "resolution" is required and must be a non-empty string`);
    }

    // Status (optional — defaults to 'confirmed' at runtime)
    if (e.status !== undefined) {
      const validStatuses = ['confirmed', 'pending', 'expired'];
      if (typeof e.status !== 'string' || !validStatuses.includes(e.status)) {
        throw new Error(`${prefix}: commonBlockers["${key}"] "status" must be one of ${validStatuses.join(', ')}, got "${e.status}"`);
      }
    }

    // Optional fields
    if (e.toolsNeeded !== undefined) {
      if (!Array.isArray(e.toolsNeeded)) {
        throw new Error(`${prefix}: commonBlockers["${key}"] "toolsNeeded" must be an array of strings if provided`);
      }
      for (const t of e.toolsNeeded) {
        if (typeof t !== 'string') {
          throw new Error(`${prefix}: commonBlockers["${key}"] "toolsNeeded" entries must be strings`);
        }
      }
    }

    if (e.credentials !== undefined) {
      if (typeof e.credentials !== 'string' && !Array.isArray(e.credentials)) {
        throw new Error(`${prefix}: commonBlockers["${key}"] "credentials" must be a string or array of strings if provided`);
      }
      if (Array.isArray(e.credentials)) {
        for (const c of e.credentials) {
          if (typeof c !== 'string') {
            throw new Error(`${prefix}: commonBlockers["${key}"] "credentials" entries must be strings`);
          }
        }
      }
    }

    if (e.addedFrom !== undefined && typeof e.addedFrom !== 'string') {
      throw new Error(`${prefix}: commonBlockers["${key}"] "addedFrom" must be a string if provided`);
    }

    if (e.addedAt !== undefined && typeof e.addedAt !== 'string') {
      throw new Error(`${prefix}: commonBlockers["${key}"] "addedAt" must be a string (ISO date) if provided`);
    }

    if (e.confirmedAt !== undefined && typeof e.confirmedAt !== 'string') {
      throw new Error(`${prefix}: commonBlockers["${key}"] "confirmedAt" must be a string (ISO date) if provided`);
    }

    if (e.expiresAt !== undefined && typeof e.expiresAt !== 'string') {
      throw new Error(`${prefix}: commonBlockers["${key}"] "expiresAt" must be a string (ISO date) if provided`);
    }

    if (e.lastUsedAt !== undefined && typeof e.lastUsedAt !== 'string') {
      throw new Error(`${prefix}: commonBlockers["${key}"] "lastUsedAt" must be a string (ISO date) if provided`);
    }

    if (e.successCount !== undefined && typeof e.successCount !== 'number') {
      throw new Error(`${prefix}: commonBlockers["${key}"] "successCount" must be a number if provided`);
    }
  }
}

/**
 * Audit loaded jobs for grounding configuration.
 * Emits warnings for jobs missing grounding — the "nudge" layer.
 * Exempt jobs (health-check, dispatch-check, etc.) are skipped silently.
 */
function auditGrounding(jobs: JobDefinition[]): void {
  const ungrounded: string[] = [];

  for (const job of jobs) {
    if (!job.enabled) continue;
    if (GROUNDING_EXEMPT_SLUGS.has(job.slug)) continue;
    if (!job.grounding) {
      ungrounded.push(job.slug);
    }
  }

  if (ungrounded.length > 0) {
    console.warn(
      `[JobLoader] Grounding audit: ${ungrounded.length} enabled job(s) lack grounding config: ${ungrounded.join(', ')}. ` +
      `Add a "grounding" field to declare identity and security requirements.`
    );
  }
}
