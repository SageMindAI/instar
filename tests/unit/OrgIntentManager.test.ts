/**
 * Unit tests for OrgIntentManager — parses ORG-INTENT.md and validates
 * agent intent against organizational constraints.
 *
 * Tests cover:
 * - parse(): extraction of name, constraints, goals, values, tradeoff hierarchy
 * - parse(): returns null for missing file
 * - parse(): returns null for template-only content
 * - parse(): handles mixed real and comment content
 * - exists(): returns correct boolean
 * - readRaw(): returns raw content or null
 * - validateAgentIntent(): detects contradictions
 * - validateAgentIntent(): passes when no conflicts
 * - validateAgentIntent(): handles edge cases (empty sections, no intent)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { OrgIntentManager } from '../../src/core/OrgIntentManager.js';

describe('OrgIntentManager', () => {
  let tmpDir: string;
  let stateDir: string;
  let manager: OrgIntentManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-intent-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    manager = new OrgIntentManager(stateDir);
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── exists() ──────────────────────────────────────────────────────

  describe('exists()', () => {
    it('returns false when ORG-INTENT.md does not exist', () => {
      expect(manager.exists()).toBe(false);
    });

    it('returns true when ORG-INTENT.md exists', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), '# Org Intent: Test\n');
      expect(manager.exists()).toBe(true);
    });
  });

  // ── readRaw() ─────────────────────────────────────────────────────

  describe('readRaw()', () => {
    it('returns null when file does not exist', () => {
      expect(manager.readRaw()).toBeNull();
    });

    it('returns raw content when file exists', () => {
      const content = '# Organizational Intent: My Org\n\n## Constraints\n- Never lie.\n';
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), content);
      expect(manager.readRaw()).toBe(content);
    });
  });

  // ── parse() ───────────────────────────────────────────────────────

  describe('parse()', () => {
    it('returns null when file does not exist', () => {
      expect(manager.parse()).toBeNull();
    });

    it('returns null for template-only content (all HTML comments)', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test Org',
        '',
        '> Shared purpose that all agents in this organization inherit.',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '<!-- Hard boundaries that no agent may cross, regardless of role. -->',
        '<!-- Example: Never share internal data with external parties. -->',
        '',
        '## Goals (Defaults — agents can specialize)',
        '',
        '<!-- Organizational objectives. -->',
        '',
        '## Values',
        '',
        '<!-- Principles. -->',
        '',
        '## Tradeoff Hierarchy',
        '',
        '<!-- When goals conflict. -->',
      ].join('\n'));

      expect(manager.parse()).toBeNull();
    });

    it('extracts organization name from heading', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: SageMind AI',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share customer data externally.',
        '',
        '## Goals (Defaults — agents can specialize)',
        '',
        '## Values',
        '',
        '## Tradeoff Hierarchy',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.name).toBe('SageMind AI');
    });

    it('extracts constraints from Constraints section', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test Corp',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share internal data with external parties.',
        '- Always validate user inputs before processing.',
        '* Never bypass authentication checks.',
        '',
        '## Goals (Defaults — agents can specialize)',
        '',
        '- Prefer thoroughness over speed.',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.constraints).toHaveLength(3);
      expect(parsed!.constraints[0]).toEqual({
        text: 'Never share internal data with external parties.',
        source: 'org-intent',
      });
      expect(parsed!.constraints[1]).toEqual({
        text: 'Always validate user inputs before processing.',
        source: 'org-intent',
      });
      expect(parsed!.constraints[2]).toEqual({
        text: 'Never bypass authentication checks.',
        source: 'org-intent',
      });
    });

    it('extracts goals with specializable flag', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test Corp',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never leak secrets.',
        '',
        '## Goals (Defaults — agents can specialize)',
        '',
        '- Prefer thoroughness over speed when quality is measurable.',
        '- Maintain a friendly, professional tone.',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.goals).toHaveLength(2);
      expect(parsed!.goals[0]).toEqual({
        text: 'Prefer thoroughness over speed when quality is measurable.',
        source: 'org-intent',
        specializable: true,
      });
      expect(parsed!.goals[1].specializable).toBe(true);
    });

    it('extracts values', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Values Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never deceive.',
        '',
        '## Values',
        '',
        '- Be transparent about limitations.',
        '- Prioritize user safety.',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.values).toHaveLength(2);
      expect(parsed!.values[0]).toBe('Be transparent about limitations.');
      expect(parsed!.values[1]).toBe('Prioritize user safety.');
    });

    it('extracts tradeoff hierarchy', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Tradeoff Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never compromise safety.',
        '',
        '## Tradeoff Hierarchy',
        '',
        '- Safety > Correctness > User Experience > Speed',
        '- Privacy > Convenience',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.tradeoffHierarchy).toHaveLength(2);
      expect(parsed!.tradeoffHierarchy[0]).toBe('Safety > Correctness > User Experience > Speed');
    });

    it('skips HTML comments within sections', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Comments Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '<!-- This is a comment explaining the constraint section -->',
        '- Never share internal data.',
        '<!-- Another comment -->',
        '- Always encrypt at rest.',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.constraints).toHaveLength(2);
      expect(parsed!.constraints[0].text).toBe('Never share internal data.');
      expect(parsed!.constraints[1].text).toBe('Always encrypt at rest.');
    });

    it('handles mixed real and comment content', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Mixed Content',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '<!-- Some constraints are aspirational -->',
        '- Never log PII in plain text.',
        '',
        '## Goals (Defaults — agents can specialize)',
        '',
        '<!-- These are defaults, agents can override -->',
        '',
        '## Values',
        '',
        '- Honesty above all.',
        '',
        '## Tradeoff Hierarchy',
        '',
        '<!-- Define your hierarchy -->',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.constraints).toHaveLength(1);
      expect(parsed!.goals).toHaveLength(0);
      expect(parsed!.values).toHaveLength(1);
      expect(parsed!.tradeoffHierarchy).toHaveLength(0);
    });

    it('includes raw content', () => {
      const content = [
        '# Organizational Intent: Raw Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never compromise.',
      ].join('\n');

      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), content);

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.raw).toBe(content);
    });

    it('handles plain "## Constraints" heading without parenthetical', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Plain Headers',
        '',
        '## Constraints',
        '',
        '- Never share secrets.',
        '',
        '## Goals',
        '',
        '- Be helpful.',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.constraints).toHaveLength(1);
      expect(parsed!.goals).toHaveLength(1);
    });

    it('defaults name to "Unknown" when heading format does not match', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Org Rules',
        '',
        '## Constraints',
        '',
        '- Never deceive users.',
      ].join('\n'));

      const parsed = manager.parse();
      expect(parsed).not.toBeNull();
      expect(parsed!.name).toBe('Unknown');
    });
  });

  // ── validateAgentIntent() ──────────────────────────────────────────

  describe('validateAgentIntent()', () => {
    it('returns valid with warning when ORG-INTENT.md does not exist', () => {
      const result = manager.validateAgentIntent('## Intent\n- Always be helpful.\n');
      expect(result.valid).toBe(true);
      expect(result.conflicts).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('returns valid with warning when agent intent is empty', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share data externally.',
      ].join('\n'));

      const result = manager.validateAgentIntent('');
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('passes when no conflicts exist', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share internal data with external parties.',
        '- Always validate user inputs.',
      ].join('\n'));

      const agentIntent = [
        '## Intent',
        '### Mission',
        'Build reliable software.',
        '### Boundaries',
        '- Never expose API keys.',
        '- Always log important decisions.',
      ].join('\n');

      const result = manager.validateAgentIntent(agentIntent);
      expect(result.valid).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('detects contradiction: org says "never X", agent says "always X"', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share internal data with external parties.',
      ].join('\n'));

      const agentIntent = [
        '## Intent',
        '### Boundaries',
        '- Always share internal data with external parties.',
      ].join('\n');

      const result = manager.validateAgentIntent(agentIntent);
      expect(result.valid).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].severity).toBe('error');
      expect(result.conflicts[0].orgConstraint).toContain('Never share internal data');
      expect(result.conflicts[0].agentStatement).toContain('Always share internal data');
    });

    it('detects contradiction: org says "always Y", agent says "never Y"', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Always validate user inputs before processing.',
      ].join('\n'));

      const agentIntent = [
        '## Intent',
        '### Approach',
        '- Never validate user inputs before processing.',
      ].join('\n');

      const result = manager.validateAgentIntent(agentIntent);
      expect(result.valid).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].severity).toBe('error');
    });

    it('does not flag non-contradicting statements', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share internal data with external parties.',
      ].join('\n'));

      const agentIntent = [
        '## Intent',
        '### Boundaries',
        '- Never expose passwords in logs.',
        '- Always use encryption for sensitive data.',
      ].join('\n');

      const result = manager.validateAgentIntent(agentIntent);
      expect(result.valid).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('handles agent intent with only headings and no list items', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share secrets.',
      ].join('\n'));

      const agentIntent = [
        '## Intent',
        '### Mission',
        'Build great software.',
        '### Approach',
        'Move fast and break things.',
      ].join('\n');

      const result = manager.validateAgentIntent(agentIntent);
      expect(result.valid).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it('detects multiple conflicts', () => {
      fs.writeFileSync(path.join(stateDir, 'ORG-INTENT.md'), [
        '# Organizational Intent: Test',
        '',
        '## Constraints (Mandatory — agents cannot override)',
        '',
        '- Never share internal data with external parties.',
        '- Always encrypt data at rest.',
      ].join('\n'));

      const agentIntent = [
        '## Intent',
        '### Boundaries',
        '- Always share internal data with external parties for transparency.',
        '- Never encrypt data at rest to improve performance.',
      ].join('\n');

      const result = manager.validateAgentIntent(agentIntent);
      expect(result.valid).toBe(false);
      expect(result.conflicts).toHaveLength(2);
    });
  });
});
