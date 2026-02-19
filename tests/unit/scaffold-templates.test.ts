/**
 * Unit tests for project scaffolding templates.
 */

import { describe, it, expect } from 'vitest';
import {
  generateAgentMd,
  generateUserMd,
  generateMemoryMd,
  generateClaudeMd,
} from '../../src/scaffold/templates.js';
import type { AgentIdentity } from '../../src/scaffold/templates.js';

const testIdentity: AgentIdentity = {
  name: 'Atlas',
  role: 'I am a development agent. I write code, run tests, and maintain this project.',
  personality: 'I am direct and efficient. I focus on outcomes and value action over discussion.',
  userName: 'Alice',
};

describe('generateAgentMd', () => {
  it('includes agent name as heading', () => {
    const result = generateAgentMd(testIdentity);
    expect(result).toContain('# Atlas');
  });

  it('includes agent role', () => {
    const result = generateAgentMd(testIdentity);
    expect(result).toContain('I am a development agent');
  });

  it('includes personality', () => {
    const result = generateAgentMd(testIdentity);
    expect(result).toContain('direct and efficient');
  });

  it('includes user name', () => {
    const result = generateAgentMd(testIdentity);
    expect(result).toContain('Alice');
  });

  it('includes core principles', () => {
    const result = generateAgentMd(testIdentity);
    expect(result).toContain('Build, don\'t describe');
    expect(result).toContain('Remember and grow');
    expect(result).toContain('Own the outcome');
  });
});

describe('generateUserMd', () => {
  it('includes user name as heading', () => {
    const result = generateUserMd('Alice');
    expect(result).toContain('# Alice');
  });

  it('includes communication preferences section', () => {
    const result = generateUserMd('Bob');
    expect(result).toContain('Communication Preferences');
  });

  it('includes notes section for updates', () => {
    const result = generateUserMd('Charlie');
    expect(result).toContain('Update this file');
    expect(result).toContain('Charlie');
  });
});

describe('generateMemoryMd', () => {
  it('includes agent name in heading', () => {
    const result = generateMemoryMd('Atlas');
    expect(result).toContain("Atlas's Memory");
  });

  it('includes standard sections', () => {
    const result = generateMemoryMd('Atlas');
    expect(result).toContain('Project Patterns');
    expect(result).toContain('Tools & Scripts');
    expect(result).toContain('Lessons Learned');
  });

  it('includes guidance about persistence', () => {
    const result = generateMemoryMd('Atlas');
    expect(result).toContain('persists across sessions');
  });
});

describe('generateClaudeMd', () => {
  it('includes project name', () => {
    const result = generateClaudeMd('my-project', 'Atlas', 4040, false);
    expect(result).toContain('my-project');
  });

  it('includes agent name', () => {
    const result = generateClaudeMd('my-project', 'Atlas', 4040, false);
    expect(result).toContain('Atlas');
  });

  it('includes port in runtime section', () => {
    const result = generateClaudeMd('my-project', 'Atlas', 5050, false);
    expect(result).toContain('5050');
  });

  it('includes identity file references', () => {
    const result = generateClaudeMd('my-project', 'Atlas', 4040, false);
    expect(result).toContain('.agent-kit/AGENT.md');
    expect(result).toContain('.agent-kit/USER.md');
    expect(result).toContain('.agent-kit/MEMORY.md');
  });

  it('includes initiative hierarchy', () => {
    const result = generateClaudeMd('my-project', 'Atlas', 4040, false);
    expect(result).toContain('Initiative Hierarchy');
    expect(result).toContain('Can I do it right now');
  });

  it('includes anti-patterns', () => {
    const result = generateClaudeMd('my-project', 'Atlas', 4040, false);
    expect(result).toContain('Escalate to Human');
    expect(result).toContain('Ask Permission');
  });

  it('includes telegram relay when configured', () => {
    const withTelegram = generateClaudeMd('my-project', 'Atlas', 4040, true);
    expect(withTelegram).toContain('Telegram Relay');
    expect(withTelegram).toContain('[telegram:N]');
  });

  it('excludes telegram relay when not configured', () => {
    const without = generateClaudeMd('my-project', 'Atlas', 4040, false);
    expect(without).not.toContain('Telegram Relay');
  });
});
