/**
 * Unit tests for CanonicalState — Registry-first state management.
 *
 * Tests cover:
 * - Quick facts CRUD
 * - Anti-patterns CRUD
 * - Project registry CRUD
 * - Topic-to-project binding
 * - Initialization with defaults
 * - Compact summary generation
 * - Corrupt file handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CanonicalState } from '../../src/core/CanonicalState.js';

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-test-'));
}

describe('CanonicalState', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = createTmpDir();
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe('initialize()', () => {
    it('creates default state files', () => {
      const state = new CanonicalState({ stateDir });
      const result = state.initialize('test-project', '/tmp/test-project');

      expect(result.created).toContain('quick-facts.json');
      expect(result.created).toContain('anti-patterns.json');
      expect(result.created).toContain('project-registry.json');
    });

    it('does not overwrite existing files', () => {
      const state = new CanonicalState({ stateDir });
      state.initialize('test-project', '/tmp/test-project');

      // Modify a fact
      state.setFact('Custom question', 'Custom answer', 'manual');

      // Re-initialize
      const result = state.initialize('test-project', '/tmp/test-project');
      expect(result.skipped).toContain('quick-facts.json');

      // Custom fact should still be there
      const facts = state.getQuickFacts();
      expect(facts.find(f => f.question === 'Custom question')).toBeDefined();
    });

    it('seeds default anti-patterns', () => {
      const state = new CanonicalState({ stateDir });
      state.initialize('test-project', '/tmp/test-project');

      const patterns = state.getAntiPatterns();
      expect(patterns.length).toBeGreaterThan(0);
      expect(patterns[0].id).toBe('AP-001');
    });

    it('seeds current project in registry', () => {
      const state = new CanonicalState({ stateDir });
      state.initialize('my-app', '/path/to/my-app');

      const projects = state.getProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].name).toBe('my-app');
      expect(projects[0].dir).toBe('/path/to/my-app');
    });
  });

  describe('Quick Facts', () => {
    it('adds and retrieves a fact', () => {
      const state = new CanonicalState({ stateDir });
      state.setFact('What is the port?', '4040', 'config');

      const facts = state.getQuickFacts();
      expect(facts.length).toBe(1);
      expect(facts[0].answer).toBe('4040');
    });

    it('updates an existing fact', () => {
      const state = new CanonicalState({ stateDir });
      state.setFact('What is the port?', '4040', 'config');
      state.setFact('What is the port?', '8080', 'config');

      const facts = state.getQuickFacts();
      expect(facts.length).toBe(1);
      expect(facts[0].answer).toBe('8080');
    });

    it('finds a fact by query', () => {
      const state = new CanonicalState({ stateDir });
      state.setFact('What project am I on?', 'dental-city', 'init');
      state.setFact('What is the port?', '4040', 'config');

      const found = state.findFact('project');
      expect(found).not.toBeNull();
      expect(found!.answer).toBe('dental-city');
    });

    it('returns null when no fact matches', () => {
      const state = new CanonicalState({ stateDir });
      expect(state.findFact('nonexistent')).toBeNull();
    });

    it('removes a fact', () => {
      const state = new CanonicalState({ stateDir });
      state.setFact('temp', 'value', 'test');

      expect(state.removeFact('temp')).toBe(true);
      expect(state.getQuickFacts().length).toBe(0);
    });

    it('returns false when removing non-existent fact', () => {
      const state = new CanonicalState({ stateDir });
      expect(state.removeFact('nonexistent')).toBe(false);
    });
  });

  describe('Anti-Patterns', () => {
    it('adds an anti-pattern with auto-generated ID', () => {
      const state = new CanonicalState({ stateDir });
      const ap = state.addAntiPattern({
        pattern: 'Do not deploy without testing',
        consequence: 'Production outage',
        alternative: 'Always run tests first',
      });

      expect(ap.id).toBe('AP-001');
      expect(ap.learnedAt).toBeTruthy();
    });

    it('increments IDs for multiple patterns', () => {
      const state = new CanonicalState({ stateDir });
      state.addAntiPattern({ pattern: 'first', consequence: 'bad', alternative: 'good' });
      const second = state.addAntiPattern({ pattern: 'second', consequence: 'worse', alternative: 'better' });

      expect(second.id).toBe('AP-002');
    });

    it('finds anti-patterns by query', () => {
      const state = new CanonicalState({ stateDir });
      state.addAntiPattern({ pattern: 'Deploy without testing', consequence: 'outage', alternative: 'test first' });
      state.addAntiPattern({ pattern: 'Force push to main', consequence: 'lost work', alternative: 'use PR' });

      const found = state.findAntiPatterns('deploy');
      expect(found.length).toBe(1);
      expect(found[0].pattern).toContain('Deploy');
    });
  });

  describe('Project Registry', () => {
    it('registers and retrieves a project', () => {
      const state = new CanonicalState({ stateDir });
      state.setProject({ name: 'dental-city', dir: '/path/to/dental-city' });

      const projects = state.getProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].name).toBe('dental-city');
    });

    it('updates an existing project', () => {
      const state = new CanonicalState({ stateDir });
      state.setProject({ name: 'dental-city', dir: '/path/v1' });
      state.setProject({ name: 'dental-city', dir: '/path/v2' });

      const projects = state.getProjects();
      expect(projects.length).toBe(1);
      expect(projects[0].dir).toBe('/path/v2');
    });

    it('finds project by name', () => {
      const state = new CanonicalState({ stateDir });
      state.setProject({ name: 'dental-city', dir: '/path/dc' });
      state.setProject({ name: 'sagemind', dir: '/path/sm' });

      const found = state.findProject({ name: 'dental-city' });
      expect(found).not.toBeNull();
      expect(found!.dir).toBe('/path/dc');
    });

    it('finds project by topic ID', () => {
      const state = new CanonicalState({ stateDir });
      state.setProject({ name: 'dental-city', dir: '/path/dc', topicIds: [123, 456] });

      const found = state.findProject({ topicId: 456 });
      expect(found).not.toBeNull();
      expect(found!.name).toBe('dental-city');
    });

    it('binds a topic to a project', () => {
      const state = new CanonicalState({ stateDir });
      state.setProject({ name: 'dental-city', dir: '/path/dc' });

      const result = state.bindTopicToProject(789, 'dental-city');
      expect(result).toBe(true);

      const found = state.findProject({ topicId: 789 });
      expect(found).not.toBeNull();
      expect(found!.name).toBe('dental-city');
    });

    it('returns false when binding to non-existent project', () => {
      const state = new CanonicalState({ stateDir });
      expect(state.bindTopicToProject(123, 'nonexistent')).toBe(false);
    });

    it('does not duplicate topic IDs on re-bind', () => {
      const state = new CanonicalState({ stateDir });
      state.setProject({ name: 'dc', dir: '/path/dc' });

      state.bindTopicToProject(123, 'dc');
      state.bindTopicToProject(123, 'dc'); // duplicate

      const project = state.findProject({ name: 'dc' });
      expect(project!.topicIds).toEqual([123]);
    });
  });

  describe('getCompactSummary()', () => {
    it('generates a summary with all sections', () => {
      const state = new CanonicalState({ stateDir });
      state.initialize('test-project', '/tmp/test');

      const summary = state.getCompactSummary();
      expect(summary).toContain('Quick Facts');
      expect(summary).toContain('Anti-Patterns');
    });

    it('returns empty when no state exists', () => {
      const state = new CanonicalState({ stateDir });
      const summary = state.getCompactSummary();
      expect(summary).toBe('');
    });
  });

  describe('corrupt file handling', () => {
    it('returns defaults for corrupted quick-facts', () => {
      const state = new CanonicalState({ stateDir });
      fs.writeFileSync(path.join(stateDir, 'quick-facts.json'), 'not json!!!');

      expect(state.getQuickFacts()).toEqual([]);
    });

    it('returns defaults for corrupted anti-patterns', () => {
      const state = new CanonicalState({ stateDir });
      fs.writeFileSync(path.join(stateDir, 'anti-patterns.json'), '{broken}');

      expect(state.getAntiPatterns()).toEqual([]);
    });

    it('returns defaults for corrupted project-registry', () => {
      const state = new CanonicalState({ stateDir });
      fs.writeFileSync(path.join(stateDir, 'project-registry.json'), '');

      expect(state.getProjects()).toEqual([]);
    });
  });
});
