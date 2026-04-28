#!/usr/bin/env tsx
/**
 * verify-deployed-templates.ts — Layer 7 CLI entry for the templates-drift
 * verifier.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 7.
 *
 * Wired as a daily job in `getDefaultJobs(...)` (see src/commands/init.ts).
 * Operators can disable the daily run via:
 *
 *     "monitoring": { "templatesDriftVerifier": { "enabled": false } }
 *
 * in `.instar/config.json`. Default is enabled.
 *
 * The actual verifier logic lives in `src/monitoring/templates-drift-
 * verifier.ts` so it gets type-checked by the main `tsc --noEmit` pass.
 * This file is the thin CLI wrapper invoked by tsx from the daily job.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runVerifier } from '../src/monitoring/templates-drift-verifier.js';
import { DegradationReporter } from '../src/monitoring/DegradationReporter.js';

interface ConfigShape {
  monitoring?: {
    templatesDriftVerifier?: {
      enabled?: boolean;
    };
  };
}

function readEnabledFromConfig(stateDir: string): boolean {
  const configPath = path.join(stateDir, 'config.json');
  if (!fs.existsSync(configPath)) return true; // default-on
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(raw) as ConfigShape;
    const enabled = config.monitoring?.templatesDriftVerifier?.enabled;
    if (enabled === false) return false;
    return true;
  } catch {
    return true; // unparseable config: fall back to default-on
  }
}

async function main(): Promise<void> {
  const homeDir = os.homedir();
  const stateDir = path.join(homeDir, '.instar');
  const enabled = readEnabledFromConfig(stateDir);

  // Configure the reporter with the host-level state dir so the daily
  // job can drain to the same DegradationReporter the server uses.
  const reporter = DegradationReporter.getInstance();
  reporter.configure({
    stateDir: path.join(stateDir, 'state'),
    agentName: 'host',
    instarVersion: process.env.npm_package_version ?? 'unknown',
  });

  const result = await runVerifier({ enabled, reporter });

  // Single-line summary so the daily job's stdout is grep-friendly.
  // The DegradationReporter handles operator-visible signal; this is
  // operator-curiosity output only.
  console.log(
    JSON.stringify({
      verifier: 'templates-drift',
      ...result,
    }),
  );

  if (result.errors.length > 0) {
    // Non-fatal: errors are still surfaced through the reporter. Exit
    // 0 so the daily job doesn't get marked as failed for a single
    // unreadable agent dir.
    process.stderr.write(
      `templates-drift-verifier errors:\n  - ${result.errors.join('\n  - ')}\n`,
    );
  }
}

main().catch((err) => {
  process.stderr.write(`templates-drift-verifier crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
