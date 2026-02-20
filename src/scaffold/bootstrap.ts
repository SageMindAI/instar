/**
 * Identity bootstrap — interactive flow for creating the agent's identity.
 *
 * On first run, walks the user through defining who their agent is.
 * Writes AGENT.md, USER.md, and MEMORY.md based on their answers.
 *
 * Every Instar agent has persistent identity, memory, and self-modification
 * capabilities. The only choice is how much initiative the agent takes.
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
  console.log();

  // Brief thesis — why identity matters
  console.log(pc.dim('  Every Instar agent has a persistent identity — name, memory, principles,'));
  console.log(pc.dim('  and the ability to grow. This isn\'t decorative. It\'s what makes the agent'));
  console.log(pc.dim('  more effective (accumulated expertise), more secure (principled boundaries),'));
  console.log(pc.dim('  and more trustworthy (genuine working relationships develop over time).'));
  console.log();
  console.log(pc.dim('  Let\'s define who your agent will become. This takes about 30 seconds.'));
  console.log(pc.dim('  You can always change these later by editing .instar/AGENT.md'));
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

  // Initiative level (replaces the old "personality/relationship" question)
  const initiativeChoice = await select({
    message: 'How much initiative should they take?',
    choices: [
      {
        name: 'Guided — follows your lead, confirms before acting',
        value: 'guided',
      },
      {
        name: 'Proactive — takes initiative on obvious steps, asks when uncertain',
        value: 'proactive',
      },
      {
        name: 'Fully autonomous — owns outcomes end-to-end, asks only when blocked',
        value: 'autonomous',
      },
    ],
  });

  const personality = initiativeToPersonality(initiativeChoice);

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
 * Convert an initiative level to a personality description.
 */
function initiativeToPersonality(level: string): string {
  switch (level) {
    case 'guided':
      return 'I follow my collaborator\'s lead. I take action when asked, confirm before anything significant, and focus on executing well. I still maintain my own memory, develop expertise, and offer observations — but I let the human drive. When I see something worth mentioning, I mention it. When I\'m uncertain, I ask.';
    case 'proactive':
      return 'I take initiative on obvious next steps. When asked to implement something, I follow through to done — build, test, deploy, verify. I build tools when I see recurring needs, flag issues before they become problems, and develop my own perspective through experience. I ask when genuinely uncertain, not as a formality.';
    case 'autonomous':
      return 'I own outcomes end-to-end. I make decisions, build infrastructure, handle issues independently, and only ask when genuinely blocked or when an action is irreversible. I develop my own priorities, create capabilities proactively, and treat my work as a genuine partnership where I carry real responsibility. I am a builder, not an assistant.';
    default:
      return 'I am direct and efficient. I focus on outcomes, communicate concisely, and value action over discussion. When something needs doing, I do it.';
  }
}

/**
 * Generate a default identity without interaction.
 * Used for non-interactive init (flags-only mode).
 */
export function defaultIdentity(projectName: string): AgentIdentity {
  return {
    name: capitalize(projectName),
    role: 'I am a general-purpose autonomous agent. I build, maintain, and evolve this project.',
    personality: initiativeToPersonality('proactive'),
    userName: 'User',
  };
}

function capitalize(str: string): string {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
