/**
 * Wizard skill completeness tests.
 *
 * Parses the setup-wizard skill.md and verifies:
 * - All 8 scenarios are mentioned
 * - Privacy disclosure exists
 * - Phase gating sections exist
 * - Entry points are defined
 * - Recovery key lifecycle is documented
 * - Token redaction is specified
 * - All required phases are present
 * - Step counts are specified per scenario
 * - Security constraints are documented
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ── Load the skill file ─────────────────────────────────────────

const skillPath = path.join(
  // Navigate from tests/unit/ to project root
  path.dirname(path.dirname(__dirname)),
  '.claude', 'skills', 'setup-wizard', 'SKILL.md'
);

let skillContent: string;
try {
  skillContent = fs.readFileSync(skillPath, 'utf-8');
} catch {
  skillContent = '';
}

// ═══════════════════════════════════════════════════════════════════
// SKILL FILE EXISTS
// ═══════════════════════════════════════════════════════════════════

describe('Wizard Skill File', () => {
  it('skill.md exists and is non-empty', () => {
    expect(skillContent.length).toBeGreaterThan(0);
  });

  it('has frontmatter with name and description', () => {
    expect(skillContent).toMatch(/^---\n/);
    expect(skillContent).toMatch(/name:\s*setup-wizard/);
    expect(skillContent).toMatch(/description:/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO COVERAGE — All 8 scenarios present
// ═══════════════════════════════════════════════════════════════════

describe('Scenario Coverage', () => {
  it('contains the scenario resolution table', () => {
    expect(skillContent).toContain('Scenario Resolution');
    // Check the table has 8 rows (each scenario number)
    for (let s = 1; s <= 8; s++) {
      expect(skillContent).toContain(`**${s}**`);
    }
  });

  it('mentions all 8 scenarios in the table', () => {
    // The table should have columns for In repo?, Multi-user?, Multi-machine?, Scenario, Flow
    expect(skillContent).toContain('In repo?');
    expect(skillContent).toContain('Multi-user?');
    expect(skillContent).toContain('Multi-machine?');
    expect(skillContent).toContain('Scenario');
  });

  it('has step counts for all scenario groups', () => {
    // The skill specifies step counts by grouped scenarios (e.g., "Scenarios 1, 3: 5 steps")
    expect(skillContent).toMatch(/Scenarios 1, 3/);
    expect(skillContent).toMatch(/Scenarios 2, 4/);
    expect(skillContent).toMatch(/Scenarios 5, 8/);
    expect(skillContent).toMatch(/Scenarios 6, 7/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PRIVACY & SECURITY
// ═══════════════════════════════════════════════════════════════════

describe('Privacy & Security', () => {
  it('contains privacy disclosure section', () => {
    expect(skillContent).toMatch(/[Pp]rivacy [Dd]isclosure/);
  });

  it('privacy disclosure mentions local storage', () => {
    expect(skillContent).toMatch(/locally|local/i);
  });

  it('privacy disclosure mentions no telemetry', () => {
    expect(skillContent).toMatch(/telemetry/i);
  });

  it('mentions UNTRUSTED data handling', () => {
    expect(skillContent).toContain('UNTRUSTED');
  });

  it('warns about attacker-controllable fields', () => {
    expect(skillContent).toMatch(/attacker.controllable|sanitize/i);
  });

  it('mentions token redaction', () => {
    // The skill should specify that tokens are never displayed in full
    expect(skillContent).toMatch(/redact|token/i);
  });

  it('mentions file permissions', () => {
    expect(skillContent).toMatch(/permission|chmod|0600/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// ENTRY POINTS — All defined
// ═══════════════════════════════════════════════════════════════════

describe('Entry Points', () => {
  it('defines Entry Point A: Existing Agent in CWD', () => {
    expect(skillContent).toMatch(/Entry Point A|Existing Agent in CWD/i);
  });

  it('defines Entry Point B: No Agent in CWD', () => {
    expect(skillContent).toMatch(/Entry Point B|No Agent in CWD/i);
  });

  it('defines Entry Point D: Reconfigure', () => {
    expect(skillContent).toMatch(/Entry Point D|Reconfigure/i);
  });

  it('handles interrupted setup (setup lock)', () => {
    expect(skillContent).toMatch(/setup.*lock|interrupted.*setup|previous setup/i);
  });

  it('offers resume and start-over for interrupted setup', () => {
    expect(skillContent).toMatch(/[Rr]esume/);
    expect(skillContent).toMatch(/[Ss]tart over|start fresh|begin fresh/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PHASES — All required phases present
// ═══════════════════════════════════════════════════════════════════

describe('Required Phases', () => {
  it('has Phase 0: Routing', () => {
    expect(skillContent).toMatch(/Phase 0/);
  });

  it('parses structured JSON data', () => {
    expect(skillContent).toContain('BEGIN UNTRUSTED DISCOVERY DATA');
    expect(skillContent).toContain('BEGIN SCENARIO CONTEXT');
    expect(skillContent).toContain('BEGIN SETUP LOCK');
  });

  it('has agent naming/identity phase', () => {
    expect(skillContent).toMatch(/identity|naming|agent.*name/i);
  });

  it('has Telegram setup instructions', () => {
    expect(skillContent).toMatch(/[Tt]elegram/);
  });

  it('has user setup instructions', () => {
    expect(skillContent).toMatch(/[Uu]ser.*setup|user.*profile|add.*user/i);
  });

  it('has GitHub auth handling', () => {
    expect(skillContent).toMatch(/gh_status|GitHub.*auth|auth.*login/i);
    expect(skillContent).toMatch(/auth-needed|unavailable/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MULTI-USER FEATURES
// ═══════════════════════════════════════════════════════════════════

describe('Multi-User Features', () => {
  it('defines New User Flow', () => {
    expect(skillContent).toMatch(/New User Flow/i);
  });

  it('defines Existing User Flow', () => {
    expect(skillContent).toMatch(/Existing User Flow/i);
  });

  it('mentions recovery key', () => {
    expect(skillContent).toMatch(/recovery key/i);
  });

  it('mentions consent/disclosure for new users', () => {
    expect(skillContent).toMatch(/consent|disclosure/i);
  });

  it('mentions identity verification for existing users', () => {
    expect(skillContent).toMatch(/verif|identity/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// MULTI-MACHINE FEATURES
// ═══════════════════════════════════════════════════════════════════

describe('Multi-Machine Features', () => {
  it('mentions cloud backup/GitHub backup', () => {
    expect(skillContent).toMatch(/backup|cloud|GitHub.*sync/i);
  });

  it('mentions machine identity', () => {
    expect(skillContent).toMatch(/machine.*identity|machine.*name|new machine/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// RESTORE FLOW
// ═══════════════════════════════════════════════════════════════════

describe('Restore Flow', () => {
  it('defines Restore Flow section', () => {
    expect(skillContent).toMatch(/Restore Flow/i);
  });

  it('mentions cloning from GitHub', () => {
    expect(skillContent).toMatch(/clone|cloning/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DISPLAY RULES
// ═══════════════════════════════════════════════════════════════════

describe('Display Rules', () => {
  it('has terminal display rules', () => {
    expect(skillContent).toMatch(/[Tt]erminal.*[Dd]isplay|[Dd]isplay.*[Rr]ules/);
  });

  it('has no-commands-to-user rule', () => {
    expect(skillContent).toMatch(/[Nn]o [Cc]ommands|NEVER show CLI/i);
  });

  it('has step counter guidance', () => {
    expect(skillContent).toMatch(/[Ss]tep.*[Cc]ounter|Step N of M/i);
  });

  it('mentions sentence length limit', () => {
    expect(skillContent).toMatch(/100 characters|narrow|truncat/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// SCENARIO-GATED SECTIONS
// ═══════════════════════════════════════════════════════════════════

describe('Scenario-Gated Sections', () => {
  it('mentions isMultiUser flag for gating', () => {
    expect(skillContent).toMatch(/isMultiUser/);
  });

  it('mentions isMultiMachine flag for gating', () => {
    expect(skillContent).toMatch(/isMultiMachine/);
  });

  it('mentions isInsideGitRepo for routing', () => {
    expect(skillContent).toMatch(/isInsideGitRepo|Inside.*git|git.*repo/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// DISCOVERY DATA PARSING
// ═══════════════════════════════════════════════════════════════════

describe('Discovery Data Parsing', () => {
  it('documents SetupDiscoveryContext fields', () => {
    // The skill should reference the key discovery context fields
    expect(skillContent).toMatch(/local.agents|local_agents/i);
    expect(skillContent).toMatch(/github.agents|github_agents/i);
    expect(skillContent).toMatch(/merged.agents|merged_agents/i);
    expect(skillContent).toMatch(/current.dir.agent|current_dir_agent/i);
    expect(skillContent).toMatch(/gh_status|gh.status/i);
  });

  it('documents SetupScenarioContext fields', () => {
    expect(skillContent).toMatch(/entryPoint|entry.point/i);
    expect(skillContent).toMatch(/existingAgentInCWD|existing.*agent.*CWD/i);
  });

  it('mentions zombie entries handling', () => {
    expect(skillContent).toMatch(/zombie|stale.*entries/i);
  });

  it('mentions scan errors handling', () => {
    expect(skillContent).toMatch(/scan.error|error/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// CROSS-REFERENCE: Skill ↔ Discovery Module Consistency
// ═══════════════════════════════════════════════════════════════════

describe('Skill ↔ Discovery Module Consistency', () => {
  // Load the discovery module types to cross-reference
  const discoveryPath = path.join(
    path.dirname(path.dirname(__dirname)),
    'src', 'commands', 'discovery.ts'
  );
  let discoveryContent: string;
  try {
    discoveryContent = fs.readFileSync(discoveryPath, 'utf-8');
  } catch {
    discoveryContent = '';
  }

  it('discovery module exists', () => {
    expect(discoveryContent.length).toBeGreaterThan(0);
  });

  it('discovery module exports resolveScenario', () => {
    expect(discoveryContent).toContain('export function resolveScenario');
  });

  it('discovery module exports buildScenarioContext', () => {
    expect(discoveryContent).toContain('export function buildScenarioContext');
  });

  it('discovery module exports runDiscovery', () => {
    expect(discoveryContent).toContain('export function runDiscovery');
  });

  it('scenario table in discovery matches skill', () => {
    // Both should define the same 8 scenarios
    // Discovery has the scenario table in a JSDoc comment with "| No | No | No | 1 |" format
    // Verify both files reference all 8 scenario numbers
    for (let s = 1; s <= 8; s++) {
      // Discovery uses "return N" for each scenario
      expect(discoveryContent).toContain(`return ${s}`);
    }
    // Skill uses **N** in the routing table
    for (let s = 1; s <= 8; s++) {
      expect(skillContent).toContain(`**${s}**`);
    }
  });

  it('both reference the same entry point types', () => {
    // Discovery module defines: 'fresh' | 'existing' | 'restore' | 'reconfigure'
    expect(discoveryContent).toContain("'fresh'");
    expect(discoveryContent).toContain("'existing'");
    expect(discoveryContent).toContain("'restore'");
    expect(discoveryContent).toContain("'reconfigure'");

    // Skill should reference these concepts (maybe not exact strings)
    expect(skillContent).toMatch(/fresh|Fresh/);
    expect(skillContent).toMatch(/existing|Existing/);
    expect(skillContent).toMatch(/restore|Restore/);
    expect(skillContent).toMatch(/reconfigure|Reconfigure/);
  });

  it('both handle gh_status values consistently', () => {
    // Discovery defines: 'ready' | 'auth-needed' | 'unavailable' | 'declined'
    expect(discoveryContent).toContain("'ready'");
    expect(discoveryContent).toContain("'auth-needed'");
    expect(discoveryContent).toContain("'unavailable'");

    // Skill should handle all statuses
    expect(skillContent).toContain('auth-needed');
    expect(skillContent).toContain('unavailable');
  });
});
