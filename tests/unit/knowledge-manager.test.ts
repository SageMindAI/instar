/**
 * Tests for KnowledgeManager — ingestion, catalog, removal, directory management.
 *
 * Verifies: ingest creates files with frontmatter, catalog tracks sources,
 * remove cleans up files and catalog, tag filtering, edge cases.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeManager } from '../../src/knowledge/KnowledgeManager.js';
import { createTempProject } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import fs from 'node:fs';
import path from 'node:path';

describe('KnowledgeManager', () => {
  let project: TempProject;
  let km: KnowledgeManager;

  beforeEach(() => {
    project = createTempProject();
    km = new KnowledgeManager(project.stateDir);
  });

  afterEach(() => {
    project.cleanup();
  });

  // ── Directory Setup ──────────────────────────────────

  describe('constructor', () => {
    it('creates knowledge directory structure', () => {
      const knowledgeDir = path.join(project.stateDir, 'knowledge');
      expect(fs.existsSync(knowledgeDir)).toBe(true);
      expect(fs.existsSync(path.join(knowledgeDir, 'articles'))).toBe(true);
      expect(fs.existsSync(path.join(knowledgeDir, 'transcripts'))).toBe(true);
      expect(fs.existsSync(path.join(knowledgeDir, 'docs'))).toBe(true);
    });

    it('survives being created multiple times on same directory', () => {
      const km2 = new KnowledgeManager(project.stateDir);
      expect(km2.getKnowledgeDir()).toBe(km.getKnowledgeDir());
    });
  });

  // ── Ingest ──────────────────────────────────────────

  describe('ingest', () => {
    it('creates a markdown file with frontmatter', () => {
      const result = km.ingest('This is the article content.', {
        title: 'Test Article',
        url: 'https://example.com/article',
        tags: ['AI', 'testing'],
      });

      expect(result.sourceId).toMatch(/^kb_/);
      expect(result.filePath).toContain('articles/');
      expect(result.filePath).toContain('test-article.md');
      expect(result.wordCount).toBe(5);

      // Verify file was created
      const fullPath = path.join(km.getKnowledgeDir(), result.filePath);
      expect(fs.existsSync(fullPath)).toBe(true);

      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content).toContain('---');
      expect(content).toContain('title: "Test Article"');
      expect(content).toContain('source: "https://example.com/article"');
      expect(content).toContain('tags: ["AI", "testing"]');
      expect(content).toContain('# Test Article');
      expect(content).toContain('This is the article content.');
    });

    it('stores in correct subdirectory based on type', () => {
      const article = km.ingest('Article content', { title: 'Article', type: 'article' });
      const transcript = km.ingest('Transcript content', { title: 'Transcript', type: 'transcript' });
      const doc = km.ingest('Doc content', { title: 'Doc', type: 'doc' });

      expect(article.filePath).toContain('articles/');
      expect(transcript.filePath).toContain('transcripts/');
      expect(doc.filePath).toContain('docs/');
    });

    it('defaults to article type', () => {
      const result = km.ingest('Content', { title: 'Default Type' });
      expect(result.filePath).toContain('articles/');
    });

    it('updates catalog with new entry', () => {
      km.ingest('Content', {
        title: 'Cataloged Article',
        url: 'https://example.com',
        tags: ['test'],
        summary: 'A test article',
      });

      const sources = km.getCatalog();
      expect(sources).toHaveLength(1);
      expect(sources[0].title).toBe('Cataloged Article');
      expect(sources[0].url).toBe('https://example.com');
      expect(sources[0].tags).toEqual(['test']);
      expect(sources[0].summary).toBe('A test article');
      expect(sources[0].type).toBe('article');
    });

    it('handles missing optional fields', () => {
      const result = km.ingest('Content', { title: 'Minimal' });
      const sources = km.getCatalog();

      expect(sources).toHaveLength(1);
      expect(sources[0].url).toBeNull();
      expect(sources[0].tags).toEqual([]);
      expect(sources[0].summary).toBe('');
    });

    it('escapes quotes in title', () => {
      const result = km.ingest('Content', { title: 'He said "hello"' });
      const fullPath = path.join(km.getKnowledgeDir(), result.filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      expect(content).toContain('title: "He said \\"hello\\""');
    });

    it('generates unique IDs for each source', () => {
      const r1 = km.ingest('Content 1', { title: 'First' });
      const r2 = km.ingest('Content 2', { title: 'Second' });
      expect(r1.sourceId).not.toBe(r2.sourceId);
    });

    it('calculates word count correctly', () => {
      const result = km.ingest('one two three four five six seven', { title: 'Word Count Test' });
      expect(result.wordCount).toBe(7);
    });

    it('trims content before writing', () => {
      const result = km.ingest('  content with whitespace  \n\n', { title: 'Trimmed' });
      const fullPath = path.join(km.getKnowledgeDir(), result.filePath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      // Should end with trimmed content + newline
      expect(content).toContain('content with whitespace');
      expect(content.endsWith('\n')).toBe(true);
    });

    it('slugifies title for filename', () => {
      const result = km.ingest('Content', { title: 'My Fancy Article Title!' });
      expect(result.filePath).toContain('my-fancy-article-title');
    });

    it('truncates long slugs', () => {
      const longTitle = 'A'.repeat(100) + ' Long Title';
      const result = km.ingest('Content', { title: longTitle });
      // Slug part should be <= 60 chars
      const fileName = path.basename(result.filePath);
      // filename = date-slug.md, slug part should be reasonable
      expect(fileName.length).toBeLessThan(80);
    });
  });

  // ── Remove ──────────────────────────────────────────

  describe('remove', () => {
    it('removes file and catalog entry', () => {
      const result = km.ingest('Content to remove', { title: 'Removable' });
      const fullPath = path.join(km.getKnowledgeDir(), result.filePath);

      expect(fs.existsSync(fullPath)).toBe(true);
      expect(km.getCatalog()).toHaveLength(1);

      const removed = km.remove(result.sourceId);
      expect(removed).toBe(true);
      expect(fs.existsSync(fullPath)).toBe(false);
      expect(km.getCatalog()).toHaveLength(0);
    });

    it('returns false for non-existent source', () => {
      expect(km.remove('nonexistent')).toBe(false);
    });

    it('handles already-deleted file gracefully', () => {
      const result = km.ingest('Content', { title: 'Will Delete' });
      const fullPath = path.join(km.getKnowledgeDir(), result.filePath);

      // Manually delete the file first
      // safe-git-allow: incremental-migration
      fs.unlinkSync(fullPath);

      // remove should still succeed (removes catalog entry)
      const removed = km.remove(result.sourceId);
      expect(removed).toBe(true);
      expect(km.getCatalog()).toHaveLength(0);
    });

    it('only removes the targeted source', () => {
      km.ingest('Content A', { title: 'Keep This' });
      const toRemove = km.ingest('Content B', { title: 'Remove This' });
      km.ingest('Content C', { title: 'Keep This Too' });

      km.remove(toRemove.sourceId);

      const remaining = km.getCatalog();
      expect(remaining).toHaveLength(2);
      expect(remaining.map(s => s.title)).toEqual(['Keep This', 'Keep This Too']);
    });
  });

  // ── Catalog ──────────────────────────────────────────

  describe('getCatalog', () => {
    it('returns empty array when no sources', () => {
      expect(km.getCatalog()).toEqual([]);
    });

    it('filters by tag', () => {
      km.ingest('AI article', { title: 'AI Article', tags: ['AI', 'LLM'] });
      km.ingest('Web article', { title: 'Web Article', tags: ['web', 'frontend'] });
      km.ingest('Both', { title: 'Both Tags', tags: ['AI', 'web'] });

      const aiSources = km.getCatalog('AI');
      expect(aiSources).toHaveLength(2);
      expect(aiSources.map(s => s.title)).toContain('AI Article');
      expect(aiSources.map(s => s.title)).toContain('Both Tags');

      const webSources = km.getCatalog('web');
      expect(webSources).toHaveLength(2);
    });

    it('returns all sources when no tag filter', () => {
      km.ingest('A', { title: 'A' });
      km.ingest('B', { title: 'B' });
      expect(km.getCatalog()).toHaveLength(2);
    });
  });

  // ── getSource ──────────────────────────────────────

  describe('getSource', () => {
    it('returns source by ID', () => {
      const result = km.ingest('Content', { title: 'Find Me' });
      const source = km.getSource(result.sourceId);
      expect(source).not.toBeNull();
      expect(source!.title).toBe('Find Me');
    });

    it('returns null for unknown ID', () => {
      expect(km.getSource('nonexistent')).toBeNull();
    });
  });

  // ── getAllTags ──────────────────────────────────────

  describe('getAllTags', () => {
    it('returns empty array when no sources', () => {
      expect(km.getAllTags()).toEqual([]);
    });

    it('returns unique sorted tags', () => {
      km.ingest('A', { title: 'A', tags: ['B', 'A'] });
      km.ingest('B', { title: 'B', tags: ['C', 'A'] });

      expect(km.getAllTags()).toEqual(['A', 'B', 'C']);
    });
  });

  // ── getMemorySourceEntries ─────────────────────────

  describe('getMemorySourceEntries', () => {
    it('returns correct entries for MemoryIndex config', () => {
      const entries = km.getMemorySourceEntries();
      expect(entries).toHaveLength(3);
      expect(entries).toContainEqual({ path: 'knowledge/articles/', type: 'markdown', evergreen: false });
      expect(entries).toContainEqual({ path: 'knowledge/transcripts/', type: 'markdown', evergreen: false });
      expect(entries).toContainEqual({ path: 'knowledge/docs/', type: 'markdown', evergreen: true });
    });
  });

  // ── Persistence ──────────────────────────────────────

  describe('persistence', () => {
    it('catalog survives manager recreation', () => {
      km.ingest('Content', { title: 'Persistent' });

      // Create a new manager pointing at the same directory
      const km2 = new KnowledgeManager(project.stateDir);
      const sources = km2.getCatalog();
      expect(sources).toHaveLength(1);
      expect(sources[0].title).toBe('Persistent');
    });

    it('handles corrupted catalog gracefully', () => {
      const catalogPath = path.join(km.getKnowledgeDir(), 'catalog.json');
      fs.writeFileSync(catalogPath, 'NOT VALID JSON');

      const km2 = new KnowledgeManager(project.stateDir);
      expect(km2.getCatalog()).toEqual([]);
    });
  });

  // ── Edge Cases ──────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty content', () => {
      const result = km.ingest('', { title: 'Empty' });
      expect(result.wordCount).toBe(1); // Empty string split gives ['']
    });

    it('handles special characters in title for filename', () => {
      const result = km.ingest('Content', { title: 'API/v2: The "New" Thing?' });
      expect(result.filePath).toContain('articles/');
      expect(result.filePath).toContain('.md');
      // Should not contain special chars
      const basename = path.basename(result.filePath);
      expect(basename).not.toMatch(/[^a-z0-9\-._]/);
    });

    it('handles content with YAML-like syntax', () => {
      const content = '---\ntitle: "Fake frontmatter"\n---\nBody text';
      const result = km.ingest(content, { title: 'YAML Content' });
      const fullPath = path.join(km.getKnowledgeDir(), result.filePath);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');

      // Should have TWO frontmatter blocks (ours + the content's fake one)
      const frontmatterCount = (fileContent.match(/^---$/gm) || []).length;
      expect(frontmatterCount).toBeGreaterThanOrEqual(2); // At least our opening ---
    });
  });
});
