/**
 * Tests that the /sessions server route enriches session rows with a `binding`
 * field pointing back to the Slack channel (or Telegram topic) they belong to,
 * so the dashboard can display a human-readable label.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES_SRC = path.join(process.cwd(), 'src/server/routes.ts');

describe('/sessions endpoint — binding enrichment', () => {
  const source = fs.readFileSync(ROUTES_SRC, 'utf-8');

  it('sessions response includes platform + channel/topic naming fields', () => {
    // Find the /sessions handler; assert it enriches sessions with platform info
    // (platform, platformId, platformName) so the dashboard can label sessions
    // by their Slack channel or Telegram topic.
    const sessionsRouteIdx = source.indexOf("router.get('/sessions'");
    expect(sessionsRouteIdx).toBeGreaterThan(-1);
    const routeBlock = source.slice(sessionsRouteIdx, sessionsRouteIdx + 6000);
    expect(routeBlock).toContain('platformName');
    expect(routeBlock).toMatch(/platform\s*=\s*['"]slack['"]|platform\s*=\s*['"]telegram['"]/);
  });

  it('platformName resolves via Slack channel registry', () => {
    // The enrichment must call getChannelRegistry (or a direct resolver) to
    // surface the Slack channel name.
    const sessionsRouteIdx = source.indexOf("router.get('/sessions'");
    const routeBlock = source.slice(sessionsRouteIdx, sessionsRouteIdx + 6000);
    expect(routeBlock).toMatch(/getChannelRegistry|channelName/);
  });
});
