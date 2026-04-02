/**
 * CapabilityMapper — Fractal self-knowledge for Instar agents.
 *
 * Discovers, classifies, and organizes all agent capabilities into a
 * hierarchical map with provenance tracking and drift detection.
 *
 * Levels:
 *   0: One-liner summary ("52 capabilities across 10 domains")
 *   1: Domain table (counts by provenance)
 *   2: Per-domain capability lists
 *   3: Deep detail per capability (endpoints, files, config refs)
 *
 * Provenance is determined exclusively via INSTAR_BUILTIN_MANIFEST lookup.
 * SKILL.md metadata.author is informational only — never used for classification.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'node:url';
import { ManifestIntegrity } from '../security/ManifestIntegrity.js';
import type { LLMSanitizer } from '../security/LLMSanitizer.js';

// ── Types ────────────────────────────────────────────────────────────

export type CapabilityType =
  | 'integration'
  | 'skill'
  | 'job'
  | 'hook'
  | 'script'
  | 'api'
  | 'subsystem'
  | 'storage'
  | 'middleware';

export type CapabilityStatus = 'active' | 'configured' | 'available' | 'disabled' | 'broken';
export type Provenance = 'instar' | 'agent' | 'user' | 'inherited' | 'unknown';

export interface Capability {
  id: string;
  name: string;
  domain: string;
  status: CapabilityStatus;
  provenance: Provenance;
  since: string;
  description: string;
  type: CapabilityType;
  contentHash?: string;
  endpoints?: string[];
  files?: string[];
  configRef?: string;
  relatedContext?: string;
  evolutionProposal?: string;
  dependencies?: string[];
  usage?: string;
  aliases?: string[];
}

export interface CapabilityDomain {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  featureCount: number;
}

export interface CapabilityMap {
  agent: string;
  version: string;
  generatedAt: string;
  summary: {
    totalCapabilities: number;
    domains: number;
    instarProvided: number;
    agentEvolved: number;
    userConfigured: number;
    unmapped: number;
  };
  domains: CapabilityDomain[];
  _links: {
    self: string;
    compact: string;
    drift: string;
    refresh: string;
    domains: Record<string, string>;
  };
  freshness: {
    ageSeconds: number;
    isRefreshing: boolean;
    lastRefresh: string;
  };
}

export interface ManifestEntry {
  provenance: Provenance;
  firstSeen: string;
  lastVerified: string;
  contentHash?: string;
  evolutionProposal?: string;
  classificationReason?: string;
  notes?: string;
}

export interface CapabilityManifest {
  schemaVersion: number;
  version: string;
  generatedAt: string;
  entries: Record<string, ManifestEntry>;
  _hmac?: string;
}

export interface DriftReport {
  generatedAt: string;
  previousScan: string;
  added: Capability[];
  removed: Array<{ id: string; name: string; domain: string }>;
  changed: Array<{ id: string; field: string; previous: unknown; current: unknown }>;
  unmapped: string[];
  scanErrors: Array<{ source: string; error: string; impact: string }>;
}

export interface BuiltinManifestEntry {
  id: string;
  type: string;
  domain: string;
  sourcePath: string;
  installedPath?: string;
  contentHash: string;
  since: string;
}

export interface CapabilityMapperConfig {
  projectDir: string;
  stateDir: string;
  projectName: string;
  version: string;
  port: number;
  /** Optional LLM sanitizer for untrusted text */
  sanitizer?: LLMSanitizer;
}

// ── Domain Definitions ───────────────────────────────────────────────

const DOMAINS: Record<string, { name: string; description: string }> = {
  communication: {
    name: 'Communication & Messaging',
    description: 'Telegram, messaging, notifications, content delivery',
  },
  memory: {
    name: 'Memory & Knowledge',
    description: 'Topic memory, semantic memory, working memory, persistent state',
  },
  scheduling: {
    name: 'Scheduling & Jobs',
    description: 'Cron jobs, skip ledger, queue management, job lifecycle',
  },
  monitoring: {
    name: 'Monitoring & Health',
    description: 'Health checks, stall detection, orphan reaping, quota tracking',
  },
  identity: {
    name: 'Identity & Users',
    description: 'Agent identity, user management, onboarding, privacy',
  },
  evolution: {
    name: 'Evolution & Growth',
    description: 'Proposals, learnings, capability gaps, actions',
  },
  publishing: {
    name: 'Publishing & Content',
    description: 'Telegraph pages, private viewer, content management',
  },
  infrastructure: {
    name: 'Infrastructure & DevOps',
    description: 'Git sync, auto-updates, hooks, scripts, sessions',
  },
  security: {
    name: 'Security & Safety',
    description: 'Auth, rate limiting, operation safety, input validation',
  },
  coordination: {
    name: 'Coordination & Multi-Agent',
    description: 'Multi-machine, agent bus, job claiming, user propagation',
  },
};

// ── Main Class ───────────────────────────────────────────────────────

export class CapabilityMapper {
  private config: CapabilityMapperConfig;
  private builtinManifest: Record<string, BuiltinManifestEntry>;
  private integrity: ManifestIntegrity;
  private isRefreshing = false;
  private lastMap: CapabilityMap | null = null;
  private lastRefreshTime: string | null = null;

  constructor(config: CapabilityMapperConfig) {
    this.config = config;
    this.builtinManifest = this.loadBuiltinManifest();
    this.integrity = new ManifestIntegrity(path.join(config.stateDir, 'state'));
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Perform a full scan and return the capability map.
   * Persists the manifest with HMAC signing.
   */
  async refresh(): Promise<CapabilityMap> {
    if (this.isRefreshing) {
      throw new Error('REFRESH_IN_PROGRESS');
    }

    this.isRefreshing = true;
    try {
      const capabilities = await this.scan();
      const classified = this.classify(capabilities);
      const domains = this.buildTree(classified);
      const map = this.buildMap(domains);

      this.persistManifest(classified);
      this.lastMap = map;
      this.lastRefreshTime = map.generatedAt;

      return map;
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * Get the last generated map, or refresh if none exists.
   */
  async getMap(): Promise<CapabilityMap> {
    if (this.lastMap) return this.lastMap;
    return this.refresh();
  }

  /**
   * Detect drift between current state and last persisted manifest.
   */
  async detectDrift(): Promise<DriftReport> {
    const previous = this.loadPersistedManifest();
    const previousScan = previous?.generatedAt ?? 'never';
    const scanErrors: DriftReport['scanErrors'] = [];

    let current: Capability[];
    try {
      current = this.classify(await this.scan());
    } catch (err) {
      return {
        generatedAt: new Date().toISOString(),
        previousScan,
        added: [],
        removed: [],
        changed: [],
        unmapped: [],
        scanErrors: [{ source: 'scan', error: String(err), impact: 'Full scan failed' }],
      };
    }

    const currentById = new Map(current.map(c => [c.id, c]));
    const previousEntries = previous?.entries ?? {};

    const added: Capability[] = [];
    const removed: DriftReport['removed'] = [];
    const changed: DriftReport['changed'] = [];
    const unmapped: string[] = [];

    // Find added and changed
    for (const cap of current) {
      const prev = previousEntries[cap.id];
      if (!prev) {
        added.push(cap);
        continue;
      }
      // Check content hash change
      if (cap.contentHash && prev.contentHash && cap.contentHash !== prev.contentHash) {
        changed.push({
          id: cap.id,
          field: 'contentHash',
          previous: prev.contentHash,
          current: cap.contentHash,
        });
      }
      // Check provenance change
      if (prev.provenance !== cap.provenance) {
        changed.push({
          id: cap.id,
          field: 'provenance',
          previous: prev.provenance,
          current: cap.provenance,
        });
      }
    }

    // Find removed
    for (const [id, entry] of Object.entries(previousEntries)) {
      if (!currentById.has(id)) {
        removed.push({ id, name: id.split(':').slice(1).join(':'), domain: '' });
      }
    }

    // Find unmapped
    for (const cap of current) {
      if (cap.provenance === 'unknown') {
        unmapped.push(cap.id);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      previousScan,
      added,
      removed,
      changed,
      unmapped,
      scanErrors,
    };
  }

  /**
   * Render the capability map as markdown.
   */
  renderMarkdown(map: CapabilityMap, level: 0 | 1 | 2 | 3 = 2): string {
    if (level <= 1) return this.renderCompactMarkdown(map);
    if (level === 2) return this.renderDomainMarkdown(map);
    return this.renderFullMarkdown(map);
  }

  /**
   * Get current refresh state.
   */
  getFreshness(): { ageSeconds: number; isRefreshing: boolean; lastRefresh: string } {
    const lastRefresh = this.lastRefreshTime ?? 'never';
    const ageSeconds = this.lastRefreshTime
      ? Math.floor((Date.now() - new Date(this.lastRefreshTime).getTime()) / 1000)
      : -1;
    return { ageSeconds, isRefreshing: this.isRefreshing, lastRefresh };
  }

  // ── Scanning ─────────────────────────────────────────────────────

  private async scan(): Promise<Capability[]> {
    const caps: Capability[] = [];
    const errors: Array<{ source: string; error: string }> = [];

    // Scan each source type, catching errors per-source
    const scanners: Array<[string, () => Capability[]]> = [
      ['skills', () => this.scanSkills()],
      ['scripts', () => this.scanScripts()],
      ['hooks', () => this.scanHooks()],
      ['jobs', () => this.scanJobs()],
      ['subsystems', () => this.scanSubsystems()],
      ['context', () => this.scanContextSegments()],
    ];

    for (const [source, scanner] of scanners) {
      try {
        caps.push(...scanner());
      } catch (err) {
        errors.push({ source, error: String(err) });
      }
    }

    return caps;
  }

  private scanSkills(): Capability[] {
    const caps: Capability[] = [];
    const skillsDir = path.join(this.config.projectDir, '.claude', 'skills');
    if (!fs.existsSync(skillsDir)) return caps;

    const folders = fs.readdirSync(skillsDir).filter(f => {
      const fullPath = path.join(skillsDir, f);
      return fs.statSync(fullPath).isDirectory() && !f.startsWith('.');
    });

    for (const folder of folders) {
      const skillMd = path.join(skillsDir, folder, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;

      const content = fs.readFileSync(skillMd, 'utf-8');
      const frontmatter = this.parseYamlFrontmatter(content);
      const hash = this.hashContent(content);

      const id = `skill:${folder}`;
      const builtinEntry = this.builtinManifest[id];

      caps.push({
        id,
        name: frontmatter.name || folder,
        domain: builtinEntry?.domain ?? this.inferDomain(id, 'skill', folder),
        status: 'active',
        provenance: 'unknown', // classified later
        since: builtinEntry?.since ?? new Date().toISOString().split('T')[0],
        description: (frontmatter.description || '').slice(0, 500),
        type: 'skill',
        contentHash: hash,
        files: [`.claude/skills/${folder}/SKILL.md`],
      });
    }

    return caps;
  }

  private scanScripts(): Capability[] {
    const caps: Capability[] = [];
    const scriptsDir = path.join(this.config.projectDir, '.claude', 'scripts');
    if (!fs.existsSync(scriptsDir)) return caps;

    const files = fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.'));

    for (const file of files) {
      const fullPath = path.join(scriptsDir, file);
      if (fs.statSync(fullPath).isDirectory()) continue;

      const content = fs.readFileSync(fullPath, 'utf-8');
      const hash = this.hashContent(content);
      const id = `script:${file}`;
      const builtinEntry = this.builtinManifest[id];

      caps.push({
        id,
        name: file,
        domain: builtinEntry?.domain ?? this.inferDomain(id, 'script', file),
        status: 'active',
        provenance: 'unknown',
        since: builtinEntry?.since ?? new Date().toISOString().split('T')[0],
        description: this.extractScriptDescription(content),
        type: 'script',
        contentHash: hash,
        files: [`.claude/scripts/${file}`],
      });
    }

    return caps;
  }

  private scanHooks(): Capability[] {
    const caps: Capability[] = [];
    const hooksBase = path.join(this.config.stateDir, 'hooks');
    if (!fs.existsSync(hooksBase)) return caps;

    // Scan both instar/ and custom/ subdirs
    for (const subdir of ['instar', 'custom']) {
      const dir = path.join(hooksBase, subdir);
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter(f => !f.startsWith('.'));
      for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) continue;

        const content = fs.readFileSync(fullPath, 'utf-8');
        const hash = this.hashContent(content);
        const id = `hook:${file}`;
        const builtinEntry = this.builtinManifest[id];

        caps.push({
          id,
          name: file,
          domain: builtinEntry?.domain ?? this.inferDomain(id, 'hook', file),
          status: 'active',
          provenance: subdir === 'instar' ? 'instar' : 'unknown',
          since: builtinEntry?.since ?? new Date().toISOString().split('T')[0],
          description: this.extractScriptDescription(content),
          type: 'hook',
          contentHash: hash,
          files: [`.instar/hooks/${subdir}/${file}`],
        });
      }
    }

    // Also scan flat hooks (pre-migration layout)
    const flatFiles = fs.readdirSync(hooksBase).filter(f => {
      const full = path.join(hooksBase, f);
      return !f.startsWith('.') && fs.statSync(full).isFile();
    });
    for (const file of flatFiles) {
      const id = `hook:${file}`;
      // Skip if already scanned from subdirectory
      if (caps.some(c => c.id === id)) continue;

      const fullPath = path.join(hooksBase, file);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const hash = this.hashContent(content);
      const builtinEntry = this.builtinManifest[id];

      caps.push({
        id,
        name: file,
        domain: builtinEntry?.domain ?? 'infrastructure',
        status: 'active',
        provenance: 'unknown',
        since: builtinEntry?.since ?? new Date().toISOString().split('T')[0],
        description: this.extractScriptDescription(content),
        type: 'hook',
        contentHash: hash,
        files: [`.instar/hooks/${file}`],
      });
    }

    return caps;
  }

  private scanJobs(): Capability[] {
    const caps: Capability[] = [];
    const jobsFile = path.join(this.config.stateDir, 'jobs.json');
    if (!fs.existsSync(jobsFile)) return caps;

    try {
      const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
      if (!Array.isArray(jobs)) return caps;

      for (const job of jobs) {
        if (!job.slug) continue;
        const id = `job:${job.slug}`;
        const builtinEntry = this.builtinManifest[id];

        caps.push({
          id,
          name: job.name || job.slug,
          domain: builtinEntry?.domain ?? this.inferDomain(id, 'job', job.slug),
          status: job.enabled === false ? 'disabled' : 'active',
          provenance: 'unknown',
          since: builtinEntry?.since ?? new Date().toISOString().split('T')[0],
          description: (job.description || '').slice(0, 500),
          type: 'job',
          contentHash: this.hashContent(JSON.stringify(job)),
        });
      }
    } catch { /* corrupt jobs.json */ }

    return caps;
  }

  private scanSubsystems(): Capability[] {
    const caps: Capability[] = [];

    // Check for subsystems by presence of config or state files
    const subsystemChecks: Array<{
      id: string;
      name: string;
      domain: string;
      check: () => boolean;
      description: string;
    }> = [
      {
        id: 'subsystem:telegram',
        name: 'Telegram Adapter',
        domain: 'communication',
        check: () => {
          const configPath = path.join(this.config.stateDir, 'config.json');
          if (!fs.existsSync(configPath)) return false;
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return config.messaging?.some((m: any) => m.type === 'telegram' && m.enabled) ?? false;
          } catch { return false; }
        },
        description: 'Bidirectional Telegram messaging with topic-based routing',
      },
      {
        id: 'subsystem:scheduler',
        name: 'Job Scheduler',
        domain: 'scheduling',
        check: () => fs.existsSync(path.join(this.config.stateDir, 'jobs.json')),
        description: 'Cron-based job scheduling with priority queuing',
      },
      {
        id: 'subsystem:evolution',
        name: 'Evolution Manager',
        domain: 'evolution',
        check: () => fs.existsSync(path.join(this.config.stateDir, 'state', 'evolution')),
        description: 'Proposals, learnings, capability gaps, and action tracking',
      },
      {
        id: 'subsystem:session-manager',
        name: 'Session Manager',
        domain: 'infrastructure',
        check: () => true, // Always present
        description: 'tmux-based Claude session lifecycle management',
      },
      {
        id: 'subsystem:state-manager',
        name: 'State Manager',
        domain: 'infrastructure',
        check: () => true,
        description: 'File-based state persistence with atomic writes',
      },
      {
        id: 'subsystem:relationships',
        name: 'Relationship Manager',
        domain: 'identity',
        check: () => {
          const configPath = path.join(this.config.stateDir, 'config.json');
          if (!fs.existsSync(configPath)) return false;
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return !!config.relationships;
          } catch { return false; }
        },
        description: 'Per-person relationship tracking with channel resolution',
      },
      {
        id: 'subsystem:topic-memory',
        name: 'Topic Memory',
        domain: 'memory',
        check: () => fs.existsSync(path.join(this.config.stateDir, 'topic-memory.db'))
          || fs.existsSync(path.join(this.config.stateDir, 'topic-memory')),
        description: 'SQLite-backed topic message indexing and search',
      },
      {
        id: 'subsystem:monitoring',
        name: 'Monitoring',
        domain: 'monitoring',
        check: () => {
          const configPath = path.join(this.config.stateDir, 'config.json');
          if (!fs.existsSync(configPath)) return false;
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return !!config.monitoring;
          } catch { return false; }
        },
        description: 'Health checks, memory pressure, quota tracking, stall detection',
      },
      {
        id: 'subsystem:publishing',
        name: 'Publishing',
        domain: 'publishing',
        check: () => {
          const configPath = path.join(this.config.stateDir, 'config.json');
          if (!fs.existsSync(configPath)) return false;
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return !!config.publishing?.enabled;
          } catch { return false; }
        },
        description: 'Telegraph page publishing and private viewer',
      },
      {
        id: 'subsystem:auto-updates',
        name: 'Auto Updates',
        domain: 'infrastructure',
        check: () => {
          const configPath = path.join(this.config.stateDir, 'config.json');
          if (!fs.existsSync(configPath)) return false;
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return !!config.updates;
          } catch { return false; }
        },
        description: 'Automatic Instar version checking and upgrade application',
      },
      {
        id: 'subsystem:playbook',
        name: 'Playbook',
        domain: 'memory',
        check: () => fs.existsSync(path.join(this.config.stateDir, 'playbook')),
        description: 'Adaptive context engineering with trigger-based assembly',
      },
      {
        id: 'subsystem:feedback',
        name: 'Feedback Manager',
        domain: 'communication',
        check: () => {
          const configPath = path.join(this.config.stateDir, 'config.json');
          if (!fs.existsSync(configPath)) return false;
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return !!config.feedback?.enabled;
          } catch { return false; }
        },
        description: 'Agent feedback collection and processing',
      },
      {
        id: 'subsystem:tunnel',
        name: 'Cloudflare Tunnel',
        domain: 'infrastructure',
        check: () => {
          const configPath = path.join(this.config.stateDir, 'config.json');
          if (!fs.existsSync(configPath)) return false;
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            return !!config.tunnel?.enabled;
          } catch { return false; }
        },
        description: 'Cloudflare tunnel for public HTTPS access',
      },
    ];

    for (const sub of subsystemChecks) {
      const exists = sub.check();
      const builtinEntry = this.builtinManifest[sub.id];

      caps.push({
        id: sub.id,
        name: sub.name,
        domain: builtinEntry?.domain ?? sub.domain,
        status: exists ? 'active' : 'available',
        provenance: 'unknown',
        since: builtinEntry?.since ?? '2025-01-01',
        description: sub.description,
        type: 'subsystem',
      });
    }

    return caps;
  }

  private scanContextSegments(): Capability[] {
    const caps: Capability[] = [];
    const contextDir = path.join(this.config.stateDir, 'context');
    if (!fs.existsSync(contextDir)) return caps;

    const files = fs.readdirSync(contextDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      const fullPath = path.join(contextDir, file);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const hash = this.hashContent(content);
      const id = `context:${file}`;
      const builtinEntry = this.builtinManifest[id];

      // Extract first heading or first line as description
      const firstLine = content.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '') ?? file;

      caps.push({
        id,
        name: firstLine.slice(0, 80),
        domain: builtinEntry?.domain ?? 'identity',
        status: 'active',
        provenance: 'unknown',
        since: builtinEntry?.since ?? new Date().toISOString().split('T')[0],
        description: firstLine,
        type: 'storage',
        contentHash: hash,
        files: [`.instar/context/${file}`],
      });
    }

    return caps;
  }

  // ── Classification ───────────────────────────────────────────────

  /**
   * Classify provenance for all capabilities using INSTAR_BUILTIN_MANIFEST.
   * This is the sole source of truth for provenance.
   */
  private classify(capabilities: Capability[]): Capability[] {
    const evolutionProposals = this.loadEvolutionProposals();

    return capabilities.map(cap => {
      // 1. Check builtin manifest (highest priority)
      const builtinEntry = this.builtinManifest[cap.id];
      if (builtinEntry) {
        // Check if content was modified (inherited)
        if (cap.contentHash && builtinEntry.contentHash && cap.contentHash !== builtinEntry.contentHash) {
          return { ...cap, provenance: 'inherited' as Provenance };
        }
        return { ...cap, provenance: 'instar' as Provenance };
      }

      // Also check by installed path for hooks
      if (cap.type === 'hook') {
        const matchByPath = Object.values(this.builtinManifest).find(
          e => e.installedPath && cap.files?.some(f => f.endsWith(e.installedPath!.replace('.instar/', '')))
        );
        if (matchByPath) {
          if (cap.contentHash && matchByPath.contentHash && cap.contentHash !== matchByPath.contentHash) {
            return { ...cap, provenance: 'inherited' as Provenance };
          }
          return { ...cap, provenance: 'instar' as Provenance };
        }
      }

      // 2. Check evolution linkage
      const evoLink = evolutionProposals.get(cap.id);
      if (evoLink) {
        return { ...cap, provenance: 'agent' as Provenance, evolutionProposal: evoLink };
      }

      // 3. Hooks in custom/ directory → agent
      if (cap.type === 'hook' && cap.files?.some(f => f.includes('/custom/'))) {
        return { ...cap, provenance: 'agent' as Provenance };
      }

      // 4. Otherwise unknown
      return cap;
    });
  }

  // ── Tree Building ────────────────────────────────────────────────

  private buildTree(capabilities: Capability[]): CapabilityDomain[] {
    const domainMap = new Map<string, Capability[]>();

    for (const cap of capabilities) {
      const domainId = cap.domain || 'infrastructure';
      if (!domainMap.has(domainId)) {
        domainMap.set(domainId, []);
      }
      domainMap.get(domainId)!.push(cap);
    }

    const domains: CapabilityDomain[] = [];

    for (const [id, caps] of domainMap) {
      const def = DOMAINS[id] ?? { name: id, description: `Agent-defined domain: ${id}` };
      domains.push({
        id,
        name: def.name,
        description: def.description,
        capabilities: caps.sort((a, b) => a.name.localeCompare(b.name)),
        featureCount: caps.length,
      });
    }

    // Sort domains: known domains first in defined order, then custom
    const domainOrder = Object.keys(DOMAINS);
    return domains.sort((a, b) => {
      const ai = domainOrder.indexOf(a.id);
      const bi = domainOrder.indexOf(b.id);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.id.localeCompare(b.id);
    });
  }

  // ── Map Building ─────────────────────────────────────────────────

  private buildMap(domains: CapabilityDomain[]): CapabilityMap {
    const allCaps = domains.flatMap(d => d.capabilities);
    const now = new Date().toISOString();

    const summary = {
      totalCapabilities: allCaps.length,
      domains: domains.length,
      instarProvided: allCaps.filter(c => c.provenance === 'instar').length,
      agentEvolved: allCaps.filter(c => c.provenance === 'agent').length,
      userConfigured: allCaps.filter(c => c.provenance === 'user').length,
      unmapped: allCaps.filter(c => c.provenance === 'unknown').length,
    };

    const domainLinks: Record<string, string> = {};
    for (const d of domains) {
      domainLinks[d.id] = `/capability-map/${d.id}`;
    }

    return {
      agent: this.config.projectName,
      version: this.config.version,
      generatedAt: now,
      summary,
      domains,
      _links: {
        self: '/capability-map',
        compact: '/capability-map?format=compact',
        drift: '/capability-map/drift',
        refresh: '/capability-map/refresh',
        domains: domainLinks,
      },
      freshness: {
        ageSeconds: 0,
        isRefreshing: false,
        lastRefresh: now,
      },
    };
  }

  // ── Markdown Rendering ───────────────────────────────────────────

  private renderCompactMarkdown(map: CapabilityMap): string {
    const lines: string[] = [
      `# Capability Map — ${map.agent}`,
      `Generated: ${map.generatedAt} | Instar ${map.version} | ${map.summary.totalCapabilities} capabilities across ${map.summary.domains} domains`,
      '',
      '| Domain | Instar | Agent | User | Total | Status |',
      '|--------|--------|-------|------|-------|--------|',
    ];

    for (const domain of map.domains) {
      const instar = domain.capabilities.filter(c => c.provenance === 'instar' || c.provenance === 'inherited').length;
      const agent = domain.capabilities.filter(c => c.provenance === 'agent').length;
      const user = domain.capabilities.filter(c => c.provenance === 'user').length;
      const total = domain.featureCount;
      const disabled = domain.capabilities.filter(c => c.status === 'disabled').length;
      const status = disabled > 0 ? `${disabled} disabled` : 'All active';
      lines.push(`| ${domain.name} | ${instar} | ${agent} | ${user} | ${total} | ${status} |`);
    }

    lines.push('');
    lines.push(`Self-discovery: GET /capability-map | GET /capability-map/:domain`);

    return lines.join('\n');
  }

  private renderDomainMarkdown(map: CapabilityMap): string {
    const lines: string[] = [
      `# Capability Map — ${map.agent}`,
      `Generated: ${map.generatedAt} | Instar ${map.version}`,
      `${map.summary.totalCapabilities} capabilities: ${map.summary.instarProvided} instar, ${map.summary.agentEvolved} agent, ${map.summary.userConfigured} user, ${map.summary.unmapped} unmapped`,
      '',
    ];

    for (const domain of map.domains) {
      lines.push(`## ${domain.name} (${domain.featureCount} capabilities)`);
      lines.push('');
      lines.push('| Capability | Type | Status | Provenance | Since |');
      lines.push('|-----------|------|--------|------------|-------|');

      for (const cap of domain.capabilities) {
        const prov = cap.evolutionProposal
          ? `${cap.provenance} (${cap.evolutionProposal})`
          : cap.provenance;
        lines.push(`| ${cap.name} | ${cap.type} | ${cap.status} | ${prov} | ${cap.since} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private renderFullMarkdown(map: CapabilityMap): string {
    const lines: string[] = [this.renderDomainMarkdown(map)];

    // Add Level 3 detail for each capability
    for (const domain of map.domains) {
      for (const cap of domain.capabilities) {
        lines.push(`### ${cap.name}`);
        lines.push('');
        lines.push(`- **ID**: ${cap.id}`);
        lines.push(`- **Type**: ${cap.type}`);
        lines.push(`- **Provenance**: ${cap.provenance} (since ${cap.since})`);
        lines.push(`- **Status**: ${cap.status}`);
        if (cap.description) lines.push(`- **Description**: ${cap.description}`);
        if (cap.endpoints?.length) lines.push(`- **Endpoints**: ${cap.endpoints.join(', ')}`);
        if (cap.files?.length) lines.push(`- **Files**: ${cap.files.join(', ')}`);
        if (cap.configRef) lines.push(`- **Config**: ${cap.configRef}`);
        if (cap.relatedContext) lines.push(`- **Related Context**: ${cap.relatedContext}`);
        if (cap.evolutionProposal) lines.push(`- **Evolution**: ${cap.evolutionProposal}`);
        if (cap.dependencies?.length) lines.push(`- **Dependencies**: ${cap.dependencies.join(', ')}`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // ── Persistence ──────────────────────────────────────────────────

  private get manifestPath(): string {
    return path.join(this.config.stateDir, 'state', 'capability-manifest.json');
  }

  private persistManifest(capabilities: Capability[]): void {
    const entries: Record<string, ManifestEntry> = {};
    const existing = this.loadPersistedManifest();

    for (const cap of capabilities) {
      const prev = existing?.entries[cap.id];
      entries[cap.id] = {
        provenance: cap.provenance,
        firstSeen: prev?.firstSeen ?? new Date().toISOString(),
        lastVerified: new Date().toISOString(),
        contentHash: cap.contentHash,
        evolutionProposal: cap.evolutionProposal,
        classificationReason: cap.provenance === 'instar' ? 'builtin-manifest match'
          : cap.provenance === 'inherited' ? 'builtin-manifest with modified content'
          : cap.provenance === 'agent' ? cap.evolutionProposal ? `evolution: ${cap.evolutionProposal}` : 'custom directory'
          : undefined,
      };
    }

    const manifest: CapabilityManifest = {
      schemaVersion: 1,
      version: this.config.version,
      generatedAt: new Date().toISOString(),
      entries,
    };

    const dir = path.dirname(this.manifestPath);
    fs.mkdirSync(dir, { recursive: true });

    try {
      this.integrity.writeAndSign(this.manifestPath, manifest as unknown as Record<string, unknown>);
    } catch {
      // If signing fails (no key), write unsigned
      fs.writeFileSync(this.manifestPath, JSON.stringify(manifest, null, 2));
    }
  }

  private loadPersistedManifest(): CapabilityManifest | null {
    if (!fs.existsSync(this.manifestPath)) return null;

    try {
      const content = fs.readFileSync(this.manifestPath, 'utf-8');
      const manifest = JSON.parse(content) as CapabilityManifest;

      // Verify HMAC if key exists
      if (this.integrity.hasKey()) {
        const verified = this.integrity.verify(manifest as unknown as Record<string, unknown>);
        if (!verified && manifest._hmac) {
          // HMAC mismatch — manifest may be tampered
          // Log warning but still return for rescan comparison
          console.warn('[CapabilityMapper] Manifest HMAC verification failed — will rescan');
        }
      }

      return manifest;
    } catch {
      return null;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  private loadBuiltinManifest(): Record<string, BuiltinManifestEntry> {
    try {
      // Try loading from the installed package first
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const manifestPath = path.join(__dirname, '..', 'data', 'builtin-manifest.json');
      if (fs.existsSync(manifestPath)) {
        const data = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        return data.entries ?? {};
      }
    } catch { /* fall through */ }

    return {};
  }

  private loadEvolutionProposals(): Map<string, string> {
    const map = new Map<string, string>();
    const evoDir = path.join(this.config.stateDir, 'state', 'evolution');
    const queueFile = path.join(evoDir, 'evolution-queue.json');

    if (!fs.existsSync(queueFile)) return map;

    try {
      const data = JSON.parse(fs.readFileSync(queueFile, 'utf-8'));
      if (data.proposals && Array.isArray(data.proposals)) {
        for (const p of data.proposals) {
          if (p.status === 'implemented' && p.id) {
            // Link proposal to capability IDs via tags or title matching
            if (p.tags && Array.isArray(p.tags)) {
              for (const tag of p.tags) {
                if (tag.startsWith('capability:')) {
                  map.set(tag.replace('capability:', ''), p.id);
                }
              }
            }
          }
        }
      }
    } catch { /* corrupt queue */ }

    return map;
  }

  private hashContent(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  private parseYamlFrontmatter(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return result;

    const yaml = match[1];
    for (const line of yaml.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !key.includes(' ')) {
        result[key] = value;
      }
    }

    return result;
  }

  private extractScriptDescription(content: string): string {
    // Look for a comment block at the top of the file
    const lines = content.split('\n');
    for (const line of lines.slice(0, 10)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
        return trimmed.replace(/^#+\s*/, '').slice(0, 200);
      }
      if (trimmed.startsWith('//')) {
        return trimmed.replace(/^\/\/\s*/, '').slice(0, 200);
      }
      if (trimmed.startsWith('/**') || trimmed.startsWith('*')) {
        const desc = trimmed.replace(/^\/?\*+\s*/, '').replace(/\*\/$/, '').trim();
        if (desc) return desc.slice(0, 200);
      }
    }
    return '';
  }

  /**
   * Infer a domain for capabilities not in the builtin manifest.
   * Uses simple heuristics based on name/type patterns.
   */
  private inferDomain(id: string, type: string, name: string): string {
    const lower = name.toLowerCase();

    if (lower.includes('telegram') || lower.includes('message') || lower.includes('notify') || lower.includes('feedback')) return 'communication';
    if (lower.includes('memory') || lower.includes('topic') || lower.includes('playbook') || lower.includes('context')) return 'memory';
    if (lower.includes('job') || lower.includes('schedule') || lower.includes('cron') || lower.includes('skip')) return 'scheduling';
    if (lower.includes('monitor') || lower.includes('health') || lower.includes('stall') || lower.includes('orphan') || lower.includes('quota')) return 'monitoring';
    if (lower.includes('agent') || lower.includes('user') || lower.includes('identity') || lower.includes('onboard')) return 'identity';
    if (lower.includes('evolution') || lower.includes('proposal') || lower.includes('learning') || lower.includes('gap')) return 'evolution';
    if (lower.includes('publish') || lower.includes('telegraph') || lower.includes('view')) return 'publishing';
    if (lower.includes('git') || lower.includes('update') || lower.includes('hook') || lower.includes('session') || lower.includes('tunnel')) return 'infrastructure';
    if (lower.includes('auth') || lower.includes('guard') || lower.includes('security') || lower.includes('safety') || lower.includes('secret') || lower.includes('credential')) return 'security';
    if (lower.includes('machine') || lower.includes('coordinate') || lower.includes('bus') || lower.includes('agent-bus')) return 'coordination';

    // Default based on type
    if (type === 'hook') return 'security';
    if (type === 'job') return 'scheduling';
    if (type === 'skill') return 'infrastructure';

    return 'infrastructure';
  }
}
