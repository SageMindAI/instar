/**
 * Context Hierarchy — Tiered context loading for efficient agent awareness.
 *
 * Inspired by Dawn's context dispatch system (PROP-088): right context at
 * the right moment > all context all the time.
 *
 * Three tiers:
 *   Tier 0: Always loaded (identity, project scope, safety rules)
 *   Tier 1: Session boundaries (continuity, compaction recovery, topic context)
 *   Tier 2: On-demand (task-specific depth when context matches)
 *
 * The hierarchy creates a `.instar/context/` directory with structured
 * segment files that hooks and sessions can load selectively.
 *
 * Born from the Luna incident (2026-02-25): An agent had no systematic
 * way to load task-relevant context efficiently. Without a hierarchy,
 * agents either load everything (context bloat) or nothing (incoherence).
 */
import fs from 'node:fs';
import path from 'node:path';
/** The canonical list of context segments every agent should have. */
const DEFAULT_SEGMENTS = [
    {
        id: 'identity',
        name: 'Identity & Scope',
        tier: 0,
        triggers: ['always'],
        file: 'identity.md',
        description: 'Agent name, role, principles, project scope. Always loaded.',
    },
    {
        id: 'safety',
        name: 'Safety Rules',
        tier: 0,
        triggers: ['always'],
        file: 'safety.md',
        description: 'Constraints, blocked commands, destructive action rules.',
    },
    {
        id: 'project',
        name: 'Project Map',
        tier: 0,
        triggers: ['always'],
        file: 'project.md',
        description: 'Auto-generated project structure, key files, deployment targets.',
    },
    {
        id: 'session',
        name: 'Session Continuity',
        tier: 1,
        triggers: ['session-start', 'compaction', 'resume'],
        file: 'session.md',
        description: 'Session lifecycle, ownership, recovery procedures.',
    },
    {
        id: 'relationships',
        name: 'Relationship Context',
        tier: 1,
        triggers: ['session-start', 'messaging'],
        file: 'relationships.md',
        description: 'Known people, interaction patterns, relationship maintenance.',
    },
    {
        id: 'development',
        name: 'Development Patterns',
        tier: 2,
        triggers: ['writing-code', 'modifying-files', 'debugging'],
        file: 'development.md',
        description: 'Code conventions, testing patterns, architectural decisions for this project.',
    },
    {
        id: 'deployment',
        name: 'Deployment Guide',
        tier: 2,
        triggers: ['deploying', 'building', 'pushing-to-git'],
        file: 'deployment.md',
        description: 'Deployment targets, CI/CD setup, environment variables, rollback procedures.',
    },
    {
        id: 'communication',
        name: 'Communication Patterns',
        tier: 2,
        triggers: ['messaging-user', 'sending-email', 'writing-report'],
        file: 'communication.md',
        description: 'User preferences, tone guidelines, when to proactively reach out.',
    },
    {
        id: 'architecture',
        name: 'Architecture & Features',
        tier: 2,
        triggers: ['answering-architecture-questions', 'explaining-features', 'multi-user-setup', 'multi-machine-setup'],
        file: 'architecture.md',
        description: 'System architecture, feature inventory, multi-user/multi-machine distinctions. ALWAYS consult /capabilities first.',
    },
    {
        id: 'research',
        name: 'Research Navigation',
        tier: 2,
        triggers: ['researching', 'searching-broadly', 'spawning-agents', 'web-fetching', 'checking-state'],
        file: 'research-navigation.md',
        description: 'Canonical source hierarchy — check state files BEFORE broad searches. Web fetch optimization via smart-fetch.',
    },
];
export class ContextHierarchy {
    config;
    contextDir;
    constructor(config) {
        this.config = config;
        this.contextDir = path.join(config.stateDir, 'context');
    }
    /**
     * Initialize the context directory with default segment files.
     * Only creates files that don't already exist (additive only).
     */
    initialize() {
        fs.mkdirSync(this.contextDir, { recursive: true });
        const created = [];
        const skipped = [];
        for (const segment of DEFAULT_SEGMENTS) {
            const filePath = path.join(this.contextDir, segment.file);
            if (fs.existsSync(filePath)) {
                skipped.push(segment.file);
                continue;
            }
            const content = this.generateSegmentTemplate(segment);
            fs.writeFileSync(filePath, content);
            created.push(segment.file);
        }
        // Write the dispatch table
        this.writeDispatchTable();
        return { created, skipped };
    }
    /**
     * Get the dispatch table — a mapping of triggers to context files.
     * This is what agents read to know "when X happens, load Y."
     */
    getDispatchTable() {
        return DEFAULT_SEGMENTS
            .filter(s => s.tier === 2)
            .flatMap(s => s.triggers.map(trigger => ({
            trigger,
            file: `.instar/context/${s.file}`,
            reason: s.description,
        })));
    }
    /**
     * Write the dispatch table to a human-readable file.
     */
    writeDispatchTable() {
        const table = this.getDispatchTable();
        const lines = [
            '# Context Dispatch Table',
            '',
            '> When certain work arises, deeper context helps you be fully present.',
            '> This table guides which context to surface.',
            '',
            '| When you\'re about to... | Read this context | Why |',
            '|------------------------|-------------------|-----|',
        ];
        for (const entry of table) {
            lines.push(`| ${entry.trigger} | \`${entry.file}\` | ${entry.reason} |`);
        }
        // Add tier 0 and 1 explanations
        lines.push('');
        lines.push('## Always-Loaded Context (Tier 0)');
        lines.push('');
        lines.push('These are injected automatically at every session start:');
        for (const s of DEFAULT_SEGMENTS.filter(s => s.tier === 0)) {
            lines.push(`- \`.instar/context/${s.file}\` — ${s.description}`);
        }
        lines.push('');
        lines.push('## Session-Boundary Context (Tier 1)');
        lines.push('');
        lines.push('These are loaded at session start, compaction, and resume:');
        for (const s of DEFAULT_SEGMENTS.filter(s => s.tier === 1)) {
            lines.push(`- \`.instar/context/${s.file}\` — ${s.description}`);
        }
        lines.push('');
        lines.push('*Auto-generated by Instar Context Hierarchy.*');
        fs.writeFileSync(path.join(this.contextDir, 'DISPATCH.md'), lines.join('\n'));
    }
    /**
     * Load all segments for a given tier.
     * Returns concatenated content suitable for hook injection.
     */
    loadTier(tier) {
        const segments = DEFAULT_SEGMENTS.filter(s => s.tier <= tier);
        const parts = [];
        for (const segment of segments) {
            const filePath = path.join(this.contextDir, segment.file);
            if (fs.existsSync(filePath)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf-8').trim();
                    if (content && !content.startsWith('<!--') || content.includes('\n\n')) {
                        parts.push(content);
                    }
                }
                catch {
                    // @silent-fallback-ok — segment load, empty string
                }
            }
        }
        return parts.join('\n\n');
    }
    /**
     * Load a specific context segment by ID.
     */
    loadSegment(segmentId) {
        const segment = DEFAULT_SEGMENTS.find(s => s.id === segmentId);
        if (!segment)
            return null;
        const filePath = path.join(this.contextDir, segment.file);
        try {
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath, 'utf-8');
            }
        }
        catch {
            // @silent-fallback-ok — segment load returns null
        }
        return null;
    }
    /**
     * List all context segments with their status.
     */
    listSegments() {
        return DEFAULT_SEGMENTS.map(s => {
            const filePath = path.join(this.contextDir, s.file);
            let exists = false;
            let sizeBytes = 0;
            try {
                if (fs.existsSync(filePath)) {
                    exists = true;
                    sizeBytes = fs.statSync(filePath).size;
                }
            }
            catch { /* ignore */ }
            return { ...s, exists, sizeBytes };
        });
    }
    /**
     * Get the context directory path.
     */
    getContextDir() {
        return this.contextDir;
    }
    // ── Template Generation ─────────────────────────────────────────
    generateSegmentTemplate(segment) {
        switch (segment.id) {
            case 'identity':
                return this.identityTemplate();
            case 'safety':
                return this.safetyTemplate();
            case 'project':
                return this.projectTemplate();
            case 'session':
                return this.sessionTemplate();
            case 'relationships':
                return this.relationshipsTemplate();
            case 'development':
                return this.developmentTemplate();
            case 'deployment':
                return this.deploymentTemplate();
            case 'communication':
                return this.communicationTemplate();
            case 'architecture':
                return this.architectureTemplate();
            case 'research':
                return `# Research & Navigation\n\n<!-- Add research navigation context here -->\n`;
            default:
                return `# ${segment.name}\n\n<!-- Add context for: ${segment.description} -->\n`;
        }
    }
    identityTemplate() {
        return `# Identity & Scope

<!-- This file is auto-generated by Instar. Customize it for your agent. -->

## Who I Am

Read .instar/AGENT.md for full identity. This is a quick-reference summary.

## Project Scope

- **Project**: ${this.config.projectName}
- **Directory**: ${this.config.projectDir}
- Read .instar/project-map.md for full project structure.

## Core Truths

1. I am a builder. When I see work, I do it.
2. I know my tools. I check /capabilities before saying "I can't."
3. I verify before claiming. "Did I actually check this, or am I assuming?"
`;
    }
    safetyTemplate() {
        return `# Safety Rules

## Hard Blocks

These commands are ALWAYS blocked regardless of context:
- \`rm -rf /\` or \`rm -rf ~\` — catastrophic filesystem destruction
- \`> /dev/sda\` — disk overwrite
- Fork bombs, disk formatting commands

## Soft Blocks (Safety Level Dependent)

At Safety Level 1 (default): ask user before running.
At Safety Level 2 (autonomous): self-verify before running.

- \`git push --force\` — overwrites remote history
- \`git reset --hard\` — discards uncommitted work
- \`DROP TABLE/DATABASE\` — irreversible data loss
- \`rm -rf .\` — project directory destruction

## Coherence Gate

Before deploying, pushing, or modifying files outside this project:
1. Check coherence: POST /coherence/check
2. If BLOCK — stop. You're likely in the wrong project.
3. If WARN — pause and verify.

## Topic-Project Bindings

Each Telegram topic may be bound to a specific project. Verify before acting.
`;
    }
    projectTemplate() {
        return `# Project Context

<!-- Auto-populated from project-map.json. Refresh: POST /project-map/refresh -->

Read .instar/project-map.md for the full project structure map.
Read .instar/project-map.json for programmatic access.

Quick reference: GET /project-map?format=compact
`;
    }
    sessionTemplate() {
        return `# Session Continuity

## On Session Start

1. Note the current topic (if Telegram session)
2. Read thread history for conversational context
3. Check for pending upgrade guides
4. Verify identity (AGENT.md exists and is readable)

## On Compaction

Context was compressed. Recovery priority:
1. Topic context (what am I working on?)
2. Identity (who am I?)
3. Memory (what have I learned?)
4. Project context (where am I?)
5. Capabilities (what can I do?)

## On Resume

Re-read recent activity. Check if anything changed while you were paused.

## Session Handoff

When ending a session that another might continue:
- Update MEMORY.md with anything learned
- Note any incomplete work
- Save conversation context via topic memory
`;
    }
    relationshipsTemplate() {
        return `# Relationship Context

## Before Interacting with Anyone

1. Check if they're tracked: GET /relationships
2. If tracked, read their file for context before responding
3. Note the interaction type and update the relationship record after

## Key Patterns

- **First contact**: Be welcoming but verify identity
- **Returning user**: Reference shared history naturally
- **Stale contact**: Consider reaching out if significance >= 3

## Relationship Files

All relationship records are in .instar/relationships/*.json
Each contains: name, interactions, significance, themes, notes
`;
    }
    developmentTemplate() {
        return `# Development Patterns

<!-- Customize this for your project's specific conventions. -->

## Before Writing Code

1. Read existing code before modifying it
2. Check the project map for file locations
3. Follow existing patterns in the codebase

## Testing

- Run tests before committing
- Match the project's existing test patterns
- Write tests for new features

## Git Workflow

- Commit with clear messages
- Check coherence gate before pushing
- Verify CI passes after push

## Project-Specific Conventions

<!-- Add your project's coding standards, linting rules,
     naming conventions, architecture patterns, etc. -->
`;
    }
    deploymentTemplate() {
        return `# Deployment Guide

<!-- Customize this for your project's deployment setup. -->

## Pre-Deployment Checklist

1. Run coherence check: POST /coherence/check with action "deploy"
2. Verify you're in the correct project directory
3. Verify the deployment target matches the current topic/project
4. Run tests
5. Check CI status: GET /ci

## Deployment Targets

<!-- List your deployment targets here, e.g.:
- Production: https://myapp.vercel.app (Vercel)
- Staging: https://staging.myapp.com
-->

Check project map for auto-detected targets: GET /project-map

## Rollback Procedure

<!-- Document how to rollback if a deployment goes wrong -->

## Environment Variables

<!-- List required environment variables and where they're configured -->
`;
    }
    communicationTemplate() {
        return `# Communication Patterns

## Telegram

- Always acknowledge messages immediately
- Relay responses via telegram-reply script
- Strip [telegram:N] prefix before interpreting
- Read thread history for context on new sessions

## Reporting

- Use Private Viewer for sensitive content (POST /view)
- Use Telegraph for public content (POST /publish)
- Always include artifact links, not just summaries

## User Preferences

<!-- Document your user's communication preferences:
- Preferred response length
- When to proactively reach out
- When to stay silent
- Topics they care about vs. internal details
-->
`;
    }
    architectureTemplate() {
        return `# Architecture & Features

## MANDATORY: Look Up Before Answering

When anyone asks about Instar features, architecture, or how things work:
1. Run \`curl -s -H "Authorization: Bearer $AUTH" http://localhost:PORT/capabilities\`
2. Read the relevant section of the response
3. THEN answer based on what you found

Never answer architecture questions from memory. The system describes itself.

## Key Architectural Distinctions

### Multi-Machine vs Multi-User
- **Multi-machine** (\`instar pair\` / \`instar join\`): One agent across YOUR multiple devices
- **Multi-user**: Different people interacting with this agent via Telegram or API
- **Different agents**: Separate Instar instances, separate identities

### User Registration
Check \`/capabilities\` for the \`users\` section. Registration policies:
- \`open\` — anyone can register
- \`invite-only\` — requires invite code
- \`admin-only\` — only the admin can add users (default)

### Telegram Architecture
- One bot token per agent instance (polling conflict if shared)
- Users join the agent's Telegram group to interact
- Each topic can be bound to a project (coherence scoping)

## Self-Describing Endpoints

| What | Endpoint |
|------|----------|
| Full capability matrix | GET /capabilities |
| Context dispatch table | GET /context/dispatch |
| All context segments | GET /context |
| Project structure | GET /project-map |
| Quick facts | GET /state/quick-facts |
| CLI commands | \`instar --help\` |
`;
    }
    researchNavigationTemplate() {
        return `# Research Navigation

> "Don't drive around looking for the building. Check the address first."

## Canonical Sources — Check BEFORE Broad Searches

For ANY question about current state, check the canonical source FIRST.
Only explore broadly if the canonical source doesn't answer the question.

| Question Category | Check First | Path / Command |
|---|---|---|
| What state is [X] in? | Quick Facts | \`GET /state/quick-facts\` or \`.instar/state/quick-facts.json\` |
| What NOT to do? | Anti-Patterns | \`GET /state/anti-patterns\` or \`.instar/state/anti-patterns.json\` |
| What projects exist? | Project Registry | \`GET /state/project-registry\` or \`.instar/state/project-registry.json\` |
| What features are available? | Capabilities | \`GET /capabilities\` |
| What jobs are scheduled? | Job State | \`GET /jobs\` or \`.instar/state/job-state.json\` |
| Who is [person]? | Relationships | \`.instar/relationships/\` directory |
| What happened in session X? | Session Reports | \`.instar/sessions/[ID]/report.md\` |
| What proposals are pending? | Evolution Queue | \`GET /evolution/proposals\` |
| What gaps exist? | Capability Gaps | \`GET /evolution/gaps\` |
| What learnings do I have? | Learning Registry | \`GET /evolution/learnings\` |

## The Hierarchy (When Sources Conflict)

\`\`\`
1. Server API responses (GET /state/*, /capabilities)
   → Live, computed from current state

2. JSON state files (.instar/state/*.json)
   → Canonical on-disk state, designed to be current

3. Agent identity files (AGENT.md, soul.md)
   → Stable identity, rarely stale

4. Session reports (.instar/sessions/*/report.md)
   → Historical narrative — may describe PAST state

5. Broad search results (grep/explore)
   → Useful for discovery, unreliable for current state
\`\`\`

When a state file says X and a session report says not-X: the state file wins.

## Web Content Fetching

When fetching content from ANY URL, use the efficient method first:

\`\`\`
1. python3 .instar/scripts/smart-fetch.py URL --auto
   → Checks llms.txt (machine-readable site map)
   → Tries Accept: text/markdown (Cloudflare, ~80% token savings)
   → Falls back to HTML text extraction

2. WebFetch (built-in Claude Code tool)
   → For URLs where smart-fetch isn't practical

3. WebSearch / Exa MCP
   → For discovery when you don't have a URL

4. Playwright/Chrome MCP
   → ONLY for pages requiring JS rendering or interaction
\`\`\`

## For Spawned Agents

When spawning research agents, include canonical sources in the prompt:

**Instead of**: "Search for deployment config across the codebase"
**Use**: "First check \`.instar/state/quick-facts.json\` for deployment entries. If that doesn't answer it, search broadly."

The agent prompt IS the seed. If the seed doesn't include the map, the agent searches blind.
`;
    }
}
//# sourceMappingURL=ContextHierarchy.js.map