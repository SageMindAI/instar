// Unit tests for the bug-fix evidence bar enforcement in the upgrade-guide
// validator. Guides that claim to fix a bug must include an Evidence section
// with either a real reproduction or an explicit "not reproducible in dev" ack.

import { describe, it, expect } from 'vitest';
// @ts-expect-error: local .mjs script, not typed
import {
  claimsFix,
  evidenceIssues,
  validateGuideContent,
  extractSection,
} from '../../scripts/upgrade-guide-validator.mjs';

const BASE_GUIDE = `# Upgrade Guide — v1.2.3

<!-- bump: patch -->

## What Changed

CHANGED_BODY

## What to Tell Your User

- **Feature**: "It's smoother now."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Something | automatic |
`;

function withChangedBody(body: string, extraSections = '') {
  return BASE_GUIDE.replace('CHANGED_BODY', body) + extraSections;
}

function withEvidence(body: string, evidenceBody: string) {
  return withChangedBody(body, `\n## Evidence\n\n${evidenceBody}\n`);
}

describe('claimsFix', () => {
  it('detects "fix" as a fix claim', () => {
    expect(claimsFix(withChangedBody('This fixes a race condition in the poller.'))).toBe(true);
  });

  it('detects "bug" as a fix claim', () => {
    expect(claimsFix(withChangedBody('Addressed a bug in the retry logic.'))).toBe(true);
  });

  it('detects "regression" as a fix claim', () => {
    expect(claimsFix(withChangedBody('Restores behavior lost in the 0.28 regression.'))).toBe(true);
  });

  it('detects "stall" as a fix claim', () => {
    expect(claimsFix(withChangedBody('Sessions no longer stall after compaction.'))).toBe(true);
  });

  it('detects "broken" as a fix claim', () => {
    expect(claimsFix(withChangedBody('Webhook delivery was broken for large payloads.'))).toBe(true);
  });

  it('detects "resolves" as a fix claim', () => {
    expect(claimsFix(withChangedBody('Resolves a race condition between A and B.'))).toBe(true);
  });

  it('does NOT flag a pure feature release as a fix', () => {
    expect(claimsFix(withChangedBody('New endpoint: POST /foo that accepts a payload and returns JSON.'))).toBe(false);
  });

  it('does NOT scan "What to Tell Your User" for fix keywords (reduces false positives)', () => {
    // Put the word "fix" only in the user-facing section — should NOT trigger.
    const guide = BASE_GUIDE
      .replace('CHANGED_BODY', 'Added a new capability for doing X.')
      .replace("It's smoother now.", 'I can fix that for you now.');
    expect(claimsFix(guide)).toBe(false);
  });
});

describe('evidenceIssues', () => {
  it('flags missing Evidence section when fix is claimed', () => {
    const guide = withChangedBody('Fixes the retry loop.');
    const issues = evidenceIssues(guide);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/no "## Evidence" section/);
  });

  it('flags Evidence section containing only template comments', () => {
    const guide = withEvidence(
      'Fixes the retry loop.',
      '<!-- this is just a comment -->'
    );
    const issues = evidenceIssues(guide);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/empty \(only template comments\)/);
  });

  it('flags Evidence section with placeholder text', () => {
    const guide = withEvidence(
      'Fixes the retry loop.',
      '[Describe reproduction + verified fix, OR "Not reproducible in dev — [reason]"]'
    );
    const issues = evidenceIssues(guide);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/placeholder text/);
  });

  it('flags Evidence section that contains TODO', () => {
    const guide = withEvidence('Fixes the bug.', 'TODO: write this later. Has enough chars to exceed min length of 80 for sure now.');
    const issues = evidenceIssues(guide);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/placeholder/);
  });

  it('flags Evidence section that is too short', () => {
    const guide = withEvidence('Fixes the bug.', 'it works');
    const issues = evidenceIssues(guide);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/too short/);
  });

  it('passes when Evidence section has substantial reproduction content', () => {
    const guide = withEvidence(
      'Fixes the retry loop when the upstream returns 503.',
      'Reproduced by pointing the client at a 503-returning mock server and watching the retry counter. ' +
      'Before: client gave up after 1 attempt. After (0.28.X installed): client retries 3 times with backoff. ' +
      'Verified via logs: "[retry] attempt 1/3 in 1s" through attempt 3/3.'
    );
    expect(evidenceIssues(guide)).toHaveLength(0);
  });

  it('passes when Evidence section uses "Not reproducible in dev" with a reason', () => {
    const guide = withEvidence(
      'Fixes a race condition between tmux pane spawn and the first prompt.',
      'Not reproducible in dev — the race only manifests on the user\'s hardware under specific ' +
      'tmux server state that cannot be replayed in CI. Mitigation: added a polling retry with an ' +
      'exponential backoff cap at 2s. Will monitor via error telemetry for one week.'
    );
    expect(evidenceIssues(guide)).toHaveLength(0);
  });
});

describe('validateGuideContent — end-to-end', () => {
  it('blocks a fix-claiming guide without Evidence', () => {
    const guide = withChangedBody('This fixes the broken poller.');
    const issues = validateGuideContent(guide);
    expect(issues.some((i: string) => i.includes('Evidence'))).toBe(true);
  });

  it('accepts a fix-claiming guide with valid Evidence', () => {
    const guide = withEvidence(
      'This fixes the broken poller that was silently dropping messages.',
      'Reproduced by sending 50 messages with the poller stopped; after restart only 48 were received. ' +
      'After fix (0.28.X), all 50 delivered. Logs show the new "[poller] flushed N pending" line for each.'
    );
    const issues = validateGuideContent(guide);
    expect(issues.filter((i: string) => i.includes('Evidence'))).toHaveLength(0);
  });

  it('accepts a pure-feature guide without Evidence section', () => {
    const guide = withChangedBody(
      'New endpoint POST /v2/things that accepts a JSON payload and returns a thing descriptor. ' +
      'Powered by the new ThingsService module.'
    );
    const issues = validateGuideContent(guide);
    expect(issues.filter((i: string) => i.includes('Evidence'))).toHaveLength(0);
  });

  it('still enforces the existing structural checks alongside Evidence', () => {
    // Missing "What Changed" entirely — should still flag, regardless of Evidence.
    const guide = BASE_GUIDE.replace('## What Changed\n\nCHANGED_BODY\n', '');
    const issues = validateGuideContent(guide);
    expect(issues.some((i: string) => i.includes('What Changed'))).toBe(true);
  });
});

describe('extractSection', () => {
  it('extracts a section body by title', () => {
    const content = '# T\n\n## Foo\n\nfoo body\n\n## Bar\n\nbar body';
    expect(extractSection(content, 'Foo')?.trim()).toBe('foo body');
    expect(extractSection(content, 'Bar')?.trim()).toBe('bar body');
  });

  it('returns null when the section is not present', () => {
    const content = '# T\n\n## Foo\n\nfoo body';
    expect(extractSection(content, 'Missing')).toBeNull();
  });
});
