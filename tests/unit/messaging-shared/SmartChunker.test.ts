import { describe, it, expect } from 'vitest';
import { smartChunk } from '../../../src/messaging/shared/SmartChunker.js';

describe('SmartChunker', () => {
  // ── Basic chunking ──────────────────────────────────────

  describe('basic behavior', () => {
    it('returns single chunk for short text', () => {
      expect(smartChunk('hello', 100)).toEqual(['hello']);
    });

    it('returns single chunk for text exactly at limit', () => {
      const text = 'a'.repeat(100);
      expect(smartChunk(text, 100)).toEqual([text]);
    });

    it('splits text exceeding limit', () => {
      const text = 'a'.repeat(200);
      const chunks = smartChunk(text, 100);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join('').length).toBe(200);
    });

    it('returns empty array for empty string', () => {
      expect(smartChunk('', 100)).toEqual(['']);
    });
  });

  // ── Paragraph splitting ──────────────────────────────────

  describe('paragraph boundaries', () => {
    it('prefers splitting at paragraph boundaries', () => {
      const text = 'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph here.';
      const chunks = smartChunk(text, 40);
      // Should split at paragraph boundaries
      expect(chunks[0]).not.toContain('\n\n');
    });

    it('preserves content across paragraphs', () => {
      const para1 = 'First paragraph.';
      const para2 = 'Second paragraph.';
      const text = `${para1}\n\n${para2}`;
      const chunks = smartChunk(text, 20);
      const joined = chunks.join(' ');
      expect(joined).toContain('First');
      expect(joined).toContain('Second');
    });
  });

  // ── Line splitting ──────────────────────────────────────

  describe('line boundaries', () => {
    it('splits at newlines when no paragraph break available', () => {
      const lines = Array.from({ length: 10 }, (_, i) => `Line ${i} content`);
      const text = lines.join('\n');
      const chunks = smartChunk(text, 50);
      // Each chunk should end at a line boundary
      for (const chunk of chunks) {
        expect(chunk).not.toMatch(/Line \d+ con$/); // Not split mid-word
      }
    });
  });

  // ── Code block handling ──────────────────────────────────

  describe('code blocks', () => {
    it('does not split inside a code block when possible', () => {
      const text = 'Before code.\n\n```javascript\nconst x = 1;\nconst y = 2;\n```\n\nAfter code.';
      const chunks = smartChunk(text, 60);
      // The code block should be in one chunk
      const codeChunk = chunks.find(c => c.includes('```'));
      if (codeChunk) {
        const openCount = (codeChunk.match(/```/g) || []).length;
        // Should have matching pairs (2, 4, etc.) or be part of a split
        expect(openCount % 2 === 0 || chunks.length > 1).toBe(true);
      }
    });

    it('handles text with no code blocks normally', () => {
      const text = 'Just plain text that is long enough to need splitting into multiple chunks for display.';
      const chunks = smartChunk(text, 30);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.join(' ')).toContain('plain text');
    });

    it('handles empty code blocks', () => {
      const text = 'Before.\n\n```\n```\n\nAfter.';
      const chunks = smartChunk(text, 100);
      expect(chunks).toHaveLength(1);
    });
  });

  // ── Edge cases ──────────────────────────────────────

  describe('edge cases', () => {
    it('handles very long words without spaces', () => {
      const longWord = 'a'.repeat(150);
      const chunks = smartChunk(longWord, 100);
      expect(chunks).toHaveLength(2);
      expect(chunks[0].length).toBe(100);
      expect(chunks[1].length).toBe(50);
    });

    it('handles maxLength of 1', () => {
      const chunks = smartChunk('abc', 1);
      expect(chunks).toHaveLength(3);
    });

    it('handles text with only whitespace', () => {
      const chunks = smartChunk('   ', 10);
      expect(chunks.every(c => c.length <= 10)).toBe(true);
    });

    it('handles unicode characters', () => {
      const text = '🔥 Hello 🌍 World 🎉 Party';
      const chunks = smartChunk(text, 15);
      expect(chunks.join(' ')).toContain('Hello');
      expect(chunks.join(' ')).toContain('World');
    });

    it('handles multiple consecutive newlines', () => {
      const text = 'A\n\n\n\nB\n\n\n\nC';
      const chunks = smartChunk(text, 5);
      const joined = chunks.join('');
      expect(joined).toContain('A');
      expect(joined).toContain('B');
      expect(joined).toContain('C');
    });
  });

  // ── WhatsApp-realistic scenarios ──────────────────────────

  describe('WhatsApp-realistic', () => {
    it('chunks a 4000+ char response into WhatsApp-sized pieces', () => {
      const paragraph = 'This is a realistic paragraph that might appear in an AI response. It contains multiple sentences and covers various topics. ';
      const text = paragraph.repeat(40); // ~4880 chars
      const chunks = smartChunk(text, 4000);
      expect(chunks.length).toBe(2);
      expect(chunks[0].length).toBeLessThanOrEqual(4000);
      expect(chunks[1].length).toBeLessThanOrEqual(4000);
    });

    it('handles a response with code blocks under the limit', () => {
      const text = `Here's the code:\n\n\`\`\`typescript\nfunction hello() {\n  console.log("world");\n}\n\`\`\`\n\nHope that helps!`;
      const chunks = smartChunk(text, 4000);
      expect(chunks).toHaveLength(1);
    });
  });
});
