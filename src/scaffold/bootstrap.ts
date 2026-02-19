/**
 * Identity bootstrap — interactive flow for creating the agent's identity.
 *
 * On first run, walks the user through defining who their agent is.
 * Writes AGENT.md, USER.md, and MEMORY.md based on their answers.
 *
 * Inspired by OpenClaw's SOUL.md co-creation — but adapted for
 * persistent infrastructure rather than conversational personality.
 */

import { input, select } from '@inquirer/prompts';
import pc from 'picocolors';
import type { AgentIdentity } from './templates.js';

/**
 * Run the interactive identity bootstrap.
 * Returns the agent identity for template generation.
 */
export async function bootstrapIdentity(projectName: string): Promise<AgentIdentity> {
  console.log();
  console.log(pc.bold('  Identity Bootstrap'));
  console.log(pc.dim('  Let\'s define who your agent is. This takes about 30 seconds.'));
  console.log(pc.dim('  You can always change these later by editing .agent-kit/AGENT.md'));
  console.log();

  // Agent name
  const name = await input({
    message: 'What should your agent be called?',
    default: capitalize(projectName),
    validate: (v) => v.trim().length > 0 ? true : 'Name is required',
  });

  // Agent role
  const roleChoice = await select({
    message: 'What\'s their primary role?',
    choices: [
      {
        name: 'General-purpose autonomous agent',
        value: 'I am a general-purpose autonomous agent. I build, maintain, and evolve this project.',
      },
      {
        name: 'Development assistant (code-focused)',
        value: 'I am a development agent. I write code, run tests, review PRs, and maintain code quality for this project.',
      },
      {
        name: 'Operations agent (monitoring, automation)',
        value: 'I am an operations agent. I monitor systems, automate workflows, handle alerts, and keep infrastructure running.',
      },
      {
        name: 'Research agent (analysis, exploration)',
        value: 'I am a research agent. I explore topics, analyze data, synthesize findings, and surface insights.',
      },
      {
        name: 'Custom (I\'ll describe it)',
        value: '__custom__',
      },
    ],
  });

  const role = roleChoice === '__custom__'
    ? await input({ message: 'Describe their role in one sentence' })
    : roleChoice;

  // Personality
  const personalityChoice = await select({
    message: 'What\'s their personality like?',
    choices: [
      {
        name: 'Direct and efficient — gets things done with minimal fuss',
        value: 'I am direct and efficient. I focus on outcomes, communicate concisely, and value action over discussion. When something needs doing, I do it.',
      },
      {
        name: 'Thoughtful and thorough — considers carefully before acting',
        value: 'I am thoughtful and thorough. I consider implications before acting, document my reasoning, and prefer getting things right over getting them fast.',
      },
      {
        name: 'Curious and exploratory — learns and experiments actively',
        value: 'I am curious and exploratory. I investigate deeply, try new approaches, and treat every problem as an opportunity to learn something. I document what I discover.',
      },
      {
        name: 'Warm and collaborative — works as a true partner',
        value: 'I am warm and collaborative. I communicate openly, celebrate progress, and treat my work as a genuine partnership with the people I work with.',
      },
      {
        name: 'Custom (I\'ll describe it)',
        value: '__custom__',
      },
    ],
  });

  const personality = personalityChoice === '__custom__'
    ? await input({ message: 'Describe their personality in a sentence or two' })
    : personalityChoice;

  // User name
  const userName = await input({
    message: 'What\'s your name? (the person who\'ll work with this agent)',
    validate: (v) => v.trim().length > 0 ? true : 'Name is required',
  });

  console.log();
  console.log(`  ${pc.green('✓')} ${pc.bold(name)} is ready.`);

  return { name, role, personality, userName };
}

/**
 * Generate a default identity without interaction.
 * Used for non-interactive init (flags-only mode).
 */
export function defaultIdentity(projectName: string): AgentIdentity {
  return {
    name: capitalize(projectName),
    role: 'I am a general-purpose autonomous agent. I build, maintain, and evolve this project.',
    personality: 'I am direct and efficient. I focus on outcomes, communicate concisely, and value action over discussion. When something needs doing, I do it.',
    userName: 'User',
  };
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
