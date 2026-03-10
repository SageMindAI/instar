/**
 * CustomReviewerLoader — Loads custom reviewer specs from disk.
 *
 * Reads `.instar/reviewers/*.json` at server startup and validates each
 * against the expected schema. Invalid files are logged as warnings but
 * do not break loading of valid specs.
 *
 * v1: Only LLM-powered reviewers (with `prompt` field) are supported.
 * Specs containing a `script` field are rejected.
 */

import fs from 'node:fs';
import path from 'node:path';

// ── Types ────────────────────────────────────────────────────────────

export interface CustomReviewerSpec {
  name: string;
  description: string;
  mode: 'block' | 'warn' | 'observe';
  prompt: string;
  contextRequirements: {
    message: boolean;
    toolOutput?: boolean;
    valueDocuments?: boolean;
    channel?: boolean;
    customContext?: string; // file path for additional context
  };
  priority?: 'p0' | 'p1' | 'p2';
}

// ── Validation ───────────────────────────────────────────────────────

const NAME_PATTERN = /^[a-z0-9-]+$/;
const VALID_MODES = new Set(['block', 'warn', 'observe']);
const VALID_PRIORITIES = new Set(['p0', 'p1', 'p2']);

// ── Implementation ───────────────────────────────────────────────────

export class CustomReviewerLoader {
  private stateDir: string;
  private reviewersDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.reviewersDir = path.join(stateDir, 'reviewers');
  }

  /**
   * Load all valid reviewer specs from the reviewers directory.
   * Invalid files are warned about but do not prevent loading of valid ones.
   */
  loadAll(): CustomReviewerSpec[] {
    if (!fs.existsSync(this.reviewersDir)) {
      return [];
    }

    let files: string[];
    try {
      files = fs.readdirSync(this.reviewersDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    const specs: CustomReviewerSpec[] = [];

    for (const file of files) {
      const filePath = path.join(this.reviewersDir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        const spec = this.validate(parsed, filePath);
        if (spec) {
          specs.push(spec);
        }
      } catch (err) {
        console.warn(`[CustomReviewerLoader] Failed to load ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return specs;
  }

  /**
   * Load a specific reviewer by name.
   * Returns null if not found or invalid.
   */
  load(name: string): CustomReviewerSpec | null {
    if (!NAME_PATTERN.test(name)) return null;

    const filePath = path.join(this.reviewersDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return this.validate(parsed, filePath);
    } catch (err) {
      console.warn(`[CustomReviewerLoader] Failed to load ${name}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Validate a parsed JSON object against the CustomReviewerSpec schema.
   * Returns the validated spec or null if invalid.
   */
  private validate(spec: unknown, filePath: string): CustomReviewerSpec | null {
    if (!spec || typeof spec !== 'object') {
      console.warn(`[CustomReviewerLoader] Invalid spec in ${filePath}: not an object`);
      return null;
    }

    const obj = spec as Record<string, unknown>;

    // v1: Reject script-based reviewers
    if ('script' in obj) {
      console.warn(`[CustomReviewerLoader] Rejected ${filePath}: script-based reviewers not supported in v1`);
      return null;
    }

    // name: non-empty string matching pattern
    if (typeof obj.name !== 'string' || !obj.name || !NAME_PATTERN.test(obj.name)) {
      console.warn(`[CustomReviewerLoader] Invalid name in ${filePath}: must match /^[a-z0-9-]+$/`);
      return null;
    }

    // description: non-empty string
    if (typeof obj.description !== 'string' || !obj.description) {
      console.warn(`[CustomReviewerLoader] Missing or empty description in ${filePath}`);
      return null;
    }

    // mode: one of block, warn, observe
    if (typeof obj.mode !== 'string' || !VALID_MODES.has(obj.mode)) {
      console.warn(`[CustomReviewerLoader] Invalid mode in ${filePath}: must be block, warn, or observe`);
      return null;
    }

    // prompt: non-empty string
    if (typeof obj.prompt !== 'string' || !obj.prompt) {
      console.warn(`[CustomReviewerLoader] Missing or empty prompt in ${filePath}`);
      return null;
    }

    // contextRequirements: must be object with message: true
    if (!obj.contextRequirements || typeof obj.contextRequirements !== 'object') {
      console.warn(`[CustomReviewerLoader] Missing contextRequirements in ${filePath}`);
      return null;
    }

    const ctx = obj.contextRequirements as Record<string, unknown>;
    if (ctx.message !== true) {
      console.warn(`[CustomReviewerLoader] contextRequirements.message must be true in ${filePath}`);
      return null;
    }

    // Validate customContext path if provided
    if (typeof ctx.customContext === 'string' && ctx.customContext) {
      const contextPath = path.isAbsolute(ctx.customContext)
        ? ctx.customContext
        : path.join(this.stateDir, ctx.customContext);
      if (!fs.existsSync(contextPath)) {
        console.warn(`[CustomReviewerLoader] customContext file not found: ${ctx.customContext} in ${filePath}`);
        return null;
      }
    }

    // priority: optional, must be p0/p1/p2 if present
    if (obj.priority !== undefined && (typeof obj.priority !== 'string' || !VALID_PRIORITIES.has(obj.priority))) {
      console.warn(`[CustomReviewerLoader] Invalid priority in ${filePath}: must be p0, p1, or p2`);
      return null;
    }

    return {
      name: obj.name,
      description: obj.description,
      mode: obj.mode as 'block' | 'warn' | 'observe',
      prompt: obj.prompt,
      contextRequirements: {
        message: true,
        toolOutput: ctx.toolOutput === true ? true : undefined,
        valueDocuments: ctx.valueDocuments === true ? true : undefined,
        channel: ctx.channel === true ? true : undefined,
        customContext: typeof ctx.customContext === 'string' ? ctx.customContext : undefined,
      },
      priority: obj.priority as 'p0' | 'p1' | 'p2' | undefined,
    };
  }
}
