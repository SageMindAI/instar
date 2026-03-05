import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ensures no CommonJS require() calls exist in ESM source files.
 * The RelationshipManager.ts previously had require('fs') which breaks in ESM.
 */
describe('ESM compliance', () => {
  const srcDir = path.join(process.cwd(), 'src');

  function getTypeScriptFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getTypeScriptFiles(fullPath));
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('no source files use require() for standard modules', () => {
    const files = getTypeScriptFiles(srcDir);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      // Match require('...') but exclude template strings and comments
      const lines = content.split('\n');
      let inTemplateLiteral = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Track template literal boundaries (rough: toggle on lines with odd backtick count)
        const backtickCount = (line.match(/`/g) || []).length;
        if (backtickCount % 2 === 1) inTemplateLiteral = !inTemplateLiteral;
        if (inTemplateLiteral) continue;
        // Skip comments
        if (line.startsWith('//') || line.startsWith('*')) continue;
        // Skip lines with backticks (inline templates)
        if (backtickCount > 0) continue;

        if (/\brequire\s*\(/.test(line)) {
          const relPath = path.relative(process.cwd(), file);
          violations.push(`${relPath}:${i + 1}: ${line}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('all source files use ESM imports', () => {
    const files = getTypeScriptFiles(srcDir);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf-8');
      // Every .ts file should have at least one import statement
      // (except possibly index.ts which re-exports)
      const hasImport = /^import /m.test(content) || /^export /m.test(content);
      if (!hasImport) {
        const relPath = path.relative(process.cwd(), file);
        // Only flag non-trivial files
        if (content.split('\n').length > 5) {
          expect.soft(hasImport, `${relPath} has no ESM imports`).toBe(true);
        }
      }
    }
  });
});
