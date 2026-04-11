/**
 * System Review CLI command — `instar review`
 *
 * Runs the System Reviewer to verify feature functionality end-to-end.
 * This is a client command that calls the running server's API endpoints.
 */

import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';

interface ReviewOptions {
  dir?: string;
  tier?: string;
  probe?: string;
  dryRun?: boolean;
  history?: boolean;
  trend?: boolean;
  json?: boolean;
}

async function apiCall(baseUrl: string, path: string, method: string, authToken?: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

export async function review(options: ReviewOptions): Promise<void> {
  let config;
  try {
    config = loadConfig(options.dir);
  } catch {
    console.log(pc.red('Not initialized. Run `instar init` first.'));
    process.exit(1);
  }

  const port = config.port ?? 4321;
  const baseUrl = `http://localhost:${port}`;
  const authToken = config.authToken;

  // Check server is running
  try {
    await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.log(pc.red('Server is not running. Start it with `instar server start`.'));
    process.exit(1);
  }

  // Route to subcommand
  if (options.history) {
    return showHistory(baseUrl, authToken, options.json);
  }
  if (options.trend) {
    return showTrend(baseUrl, authToken, options.json);
  }

  // Default: run a review
  return runReview(baseUrl, authToken, options);
}

async function runReview(baseUrl: string, authToken: string | undefined, options: ReviewOptions): Promise<void> {
  console.log(pc.bold(`\n  System Review\n`));

  const body: Record<string, unknown> = {};
  if (options.tier) body.tier = Number(options.tier);
  if (options.probe) body.probeId = options.probe;
  if (options.dryRun) body.dryRun = true;

  if (options.dryRun) {
    console.log(pc.dim('  Dry run — showing what would execute\n'));
  }

  try {
    const report = await apiCall(baseUrl, '/system-reviews', 'POST', authToken, body) as {
      status: string;
      results: Array<{
        probeId: string;
        name: string;
        tier: number;
        passed: boolean;
        description: string;
        durationMs: number;
        error?: string;
        remediation?: string[];
      }>;
      summary: { total: number; passed: number; failed: number; skipped: number };
      duration: number;
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // Group results by tier
    const byTier = new Map<number, typeof report.results>();
    for (const r of report.results) {
      const tier = r.tier;
      if (!byTier.has(tier)) byTier.set(tier, []);
      byTier.get(tier)!.push(r);
    }

    const tierNames: Record<number, string> = {
      1: 'Core Survival',
      2: 'Intelligence',
      3: 'Safety',
      4: 'Coordination',
      5: 'Communication Quality',
    };

    for (const [tier, results] of [...byTier.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(pc.bold(`  Tier ${tier}: ${tierNames[tier] ?? 'Unknown'}`));
      for (const r of results) {
        const icon = r.passed ? pc.green('✓') : pc.red('✗');
        const duration = pc.dim(`${r.durationMs}ms`);
        console.log(`    ${icon} ${r.name} ${duration}`);
        if (!r.passed && r.description) {
          console.log(pc.dim(`      ${r.description}`));
        }
        if (!r.passed && r.error) {
          console.log(pc.red(`      ${r.error}`));
        }
        if (!r.passed && r.remediation?.length) {
          for (const step of r.remediation) {
            console.log(pc.yellow(`      → ${step}`));
          }
        }
      }
      console.log();
    }

    // Summary
    const { summary } = report;
    const statusColor = report.status === 'all-clear' ? pc.green
      : report.status === 'degraded' ? pc.yellow
      : pc.red;

    console.log(pc.bold('  Summary'));
    console.log(`    Status: ${statusColor(report.status.toUpperCase())}`);
    console.log(`    ${pc.green(String(summary.passed))} passed, ${summary.failed > 0 ? pc.red(String(summary.failed)) : '0'} failed, ${summary.skipped} skipped`);
    console.log(`    Duration: ${report.duration}ms\n`);

    // Exit code per spec
    if (report.status === 'critical') process.exit(2);
    if (report.status === 'degraded') process.exit(1);
    process.exit(0);
  } catch (err) {
    console.log(pc.red(`  Review failed: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(3);
  }
}

async function showHistory(baseUrl: string, authToken: string | undefined, json?: boolean): Promise<void> {
  try {
    const data = await apiCall(baseUrl, '/system-reviews/history', 'GET', authToken) as {
      count: number;
      reports: Array<{
        timestamp: string;
        status: string;
        stats?: { total: number; passed: number; failed: number; skipped: number; durationMs: number };
        summary?: { total: number; passed: number; failed: number };
        duration?: number;
        results?: Array<{ name: string; passed: boolean }>;
      }>;
    };

    if (json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(pc.bold(`\n  Review History (${data.count} reports)\n`));

    if (data.count === 0) {
      console.log(pc.dim('  No reviews yet. Run `instar review` to start.\n'));
      return;
    }

    for (const r of data.reports.slice(-10).reverse()) {
      const statusColor = r.status === 'all-clear' ? pc.green
        : r.status === 'degraded' ? pc.yellow
        : pc.red;
      const date = new Date(r.timestamp).toLocaleString();
      const stats = r.stats ?? (r.summary ? { total: r.summary.total, passed: r.summary.passed, failed: r.summary.failed, durationMs: r.duration ?? 0 } : { total: 0, passed: 0, failed: 0, durationMs: 0 });
      console.log(`  ${pc.dim(date)}  ${statusColor(r.status.padEnd(10))}  ${pc.green(String(stats.passed))}/${stats.total} passed  ${pc.dim(`${stats.durationMs}ms`)}`);
      if (stats.failed > 0 && Array.isArray(r.results)) {
        const failedNames = r.results.filter(x => !x.passed).map(x => x.name);
        if (failedNames.length > 0) {
          console.log(pc.red(`      ✗ ${failedNames.join(', ')}`));
        }
      }
    }
    console.log();
  } catch (err) {
    console.log(pc.red(`  Failed to get history: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(3);
  }
}

async function showTrend(baseUrl: string, authToken: string | undefined, json?: boolean): Promise<void> {
  try {
    const trend = await apiCall(baseUrl, '/system-reviews/trend', 'GET', authToken) as {
      reviewCount: number;
      direction: string;
      passRate: { current: number; previous: number; delta: number };
      newFailures: string[];
      resolvedFailures: string[];
      persistentFailures: string[];
    };

    if (json) {
      console.log(JSON.stringify(trend, null, 2));
      return;
    }

    console.log(pc.bold(`\n  Review Trend (${trend.reviewCount} reviews)\n`));

    if (trend.reviewCount < 2) {
      console.log(pc.dim('  Need at least 2 reviews for trend analysis.\n'));
      return;
    }

    const dirColor = trend.direction === 'improving' ? pc.green
      : trend.direction === 'degrading' ? pc.red
      : pc.dim;
    console.log(`  Direction: ${dirColor(trend.direction)}`);
    console.log(`  Pass rate: ${(trend.passRate.current * 100).toFixed(0)}% (${trend.passRate.delta >= 0 ? '+' : ''}${(trend.passRate.delta * 100).toFixed(0)}%)`);

    if (trend.newFailures.length > 0) {
      console.log(pc.red(`\n  New failures:`));
      for (const f of trend.newFailures) console.log(pc.red(`    ✗ ${f}`));
    }
    if (trend.resolvedFailures.length > 0) {
      console.log(pc.green(`\n  Resolved:`));
      for (const f of trend.resolvedFailures) console.log(pc.green(`    ✓ ${f}`));
    }
    if (trend.persistentFailures.length > 0) {
      console.log(pc.yellow(`\n  Persistent failures:`));
      for (const f of trend.persistentFailures) console.log(pc.yellow(`    ⚠ ${f}`));
    }
    console.log();
  } catch (err) {
    console.log(pc.red(`  Failed to get trend: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(3);
  }
}
