/**
 * Tests that generated CLAUDE.md includes identity hook references.
 *
 * Verifies the fix from iteration 38: session-start.sh and
 * compaction-recovery.sh are now referenced in generated CLAUDE.md
 * so agents know to run them.
 */

import { describe, it, expect } from 'vitest';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

describe('Scaffold templates — identity hook references', () => {
  it('generates CLAUDE.md with session-start hook reference', () => {
    const content = generateClaudeMd('test-project', 'TestAgent', 4040, false);

    expect(content).toContain('.instar/hooks/instar/session-start.sh');
  });

  it('generates CLAUDE.md with compaction-recovery hook reference', () => {
    const content = generateClaudeMd('test-project', 'TestAgent', 4040, false);

    expect(content).toContain('.instar/hooks/instar/compaction-recovery.sh');
  });

  it('includes identity hooks section before agent infrastructure', () => {
    const content = generateClaudeMd('test-project', 'TestAgent', 4040, false);

    const hooksIndex = content.indexOf('Identity Hooks');
    const infraIndex = content.indexOf('Agent Infrastructure');

    expect(hooksIndex).toBeGreaterThan(0);
    expect(infraIndex).toBeGreaterThan(0);
    expect(hooksIndex).toBeLessThan(infraIndex);
  });

  it('includes Telegram relay section when hasTelegram is true', () => {
    const withTelegram = generateClaudeMd('test-project', 'TestAgent', 4040, true);
    const withoutTelegram = generateClaudeMd('test-project', 'TestAgent', 4040, false);

    expect(withTelegram).toContain('Telegram Relay');
    expect(withoutTelegram).not.toContain('Telegram Relay');
  });

  it('includes project-specific port in generated content', () => {
    const content = generateClaudeMd('test-project', 'TestAgent', 5555, false);

    expect(content).toContain('5555');
    expect(content).toContain('localhost:5555');
  });

  it('includes agent name in identity section', () => {
    const content = generateClaudeMd('test-project', 'MyAgent', 4040, false);

    expect(content).toContain('I am MyAgent');
  });

  it('includes WhatsApp section when hasWhatsApp is true', () => {
    const withWhatsApp = generateClaudeMd('test-project', 'TestAgent', 4040, false, true);
    const withoutWhatsApp = generateClaudeMd('test-project', 'TestAgent', 4040, false, false);

    expect(withWhatsApp).toContain('WhatsApp Integration');
    expect(withoutWhatsApp).not.toContain('WhatsApp Integration');
  });

  it('WhatsApp section includes commands reference', () => {
    const content = generateClaudeMd('test-project', 'TestAgent', 4040, false, true);

    expect(content).toContain('/new');
    expect(content).toContain('/status');
    expect(content).toContain('/help');
    expect(content).toContain('/whoami');
  });

  it('WhatsApp section includes privacy consent info', () => {
    const content = generateClaudeMd('test-project', 'TestAgent', 4040, false, true);

    expect(content).toContain('Privacy');
    expect(content).toContain('consent');
  });

  it('WhatsApp section includes CLI commands', () => {
    const content = generateClaudeMd('test-project', 'TestAgent', 4040, false, true);

    expect(content).toContain('instar channels login whatsapp');
    expect(content).toContain('instar channels doctor whatsapp');
    expect(content).toContain('instar channels status');
  });

  it('supports both Telegram and WhatsApp simultaneously', () => {
    const content = generateClaudeMd('test-project', 'TestAgent', 4040, true, true);

    expect(content).toContain('Telegram Relay');
    expect(content).toContain('WhatsApp Integration');
  });
});
