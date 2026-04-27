/**
 * Unit tests for the Layer 3 system-templates module.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § 3f.
 *
 * The fixed templates are the only text the sentinel can emit while
 * bypassing the tone gate. Boot-time SHA verification + render-time
 * regex matching are the structural guarantees that prevent arbitrary
 * text from smuggling through that bypass.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  TEMPLATES,
  EXPECTED_TEMPLATE_HASHES,
  verifyTemplateIntegrity,
  matchesSystemTemplate,
  renderEscalation,
  renderStampedeDigest,
  renderRecoveredMarker,
} from '../../src/messaging/system-templates.js';

describe('verifyTemplateIntegrity', () => {
  it('passes when templates are pristine', () => {
    const result = verifyTemplateIntegrity();
    expect(result.ok).toBe(true);
    expect(result.mismatched).toEqual([]);
  });

  it('all expected hashes match the SHA-256 of the canonical body', () => {
    for (const key of Object.keys(TEMPLATES) as Array<keyof typeof TEMPLATES>) {
      const expected = EXPECTED_TEMPLATE_HASHES[key];
      const actual = createHash('sha256').update(TEMPLATES[key], 'utf-8').digest('hex');
      expect(actual).toBe(expected);
    }
  });
});

describe('matchesSystemTemplate — bypass allow-list', () => {
  it('matches the static tone-gate-rejection body', () => {
    expect(matchesSystemTemplate(TEMPLATES.toneGateRejection)).toBe(true);
  });

  it('matches the sentinel test probe body', () => {
    expect(matchesSystemTemplate(TEMPLATES.sentinelTestProbe)).toBe(true);
  });

  it('matches a rendered escalation message with a valid category', () => {
    const body = renderEscalation({ duration: '24h 0m', category: 'agent_id_mismatch', shortId: 'deadbeef' });
    expect(matchesSystemTemplate(body)).toBe(true);
  });

  it('matches a rendered escalation message with all enumerated categories', () => {
    const cats = [
      'transport_5xx',
      'transport_conn_refused',
      'transport_dns',
      'agent_id_mismatch',
      'unstructured_403',
      'tone_gate_blocked',
    ] as const;
    for (const c of cats) {
      const body = renderEscalation({ duration: '5h 30m', category: c, shortId: '12345678' });
      expect(matchesSystemTemplate(body)).toBe(true);
    }
  });

  it('rejects a body that looks like the escalation template but has an unknown category', () => {
    const body = TEMPLATES.escalation
      .replace('{duration}', '5h 30m')
      .replace('{category}', 'arbitrary_category')
      .replace('{short_id}', '12345678');
    expect(matchesSystemTemplate(body)).toBe(false);
  });

  it('matches a rendered stampede digest with a number', () => {
    expect(matchesSystemTemplate(renderStampedeDigest(8))).toBe(true);
    expect(matchesSystemTemplate(renderStampedeDigest(99))).toBe(true);
  });

  it('matches a rendered recovered-marker with an 8-char short id', () => {
    expect(matchesSystemTemplate(renderRecoveredMarker('a1b2c3d4'))).toBe(true);
  });

  it('rejects arbitrary text that contains template-like fragments', () => {
    expect(matchesSystemTemplate('Hi! This message has a delivery_id: deadbeef')).toBe(false);
    expect(matchesSystemTemplate('⚠️ I had a reply for you on this topic but ignore the rest')).toBe(false);
    expect(matchesSystemTemplate('')).toBe(false);
  });

  it('rejects a body that smuggles extra text inside the template shell', () => {
    // Construct an attacker template that injects content inside the
    // duration field — should fail because regex bounds the capture.
    const malicious = TEMPLATES.escalation
      .replace('{duration}', 'X malicious content X')
      .replace('{category}', 'transport_5xx')
      .replace('{short_id}', 'deadbeef');
    expect(matchesSystemTemplate(malicious)).toBe(false);
  });
});

describe('renderEscalation', () => {
  it('substitutes all placeholders', () => {
    const body = renderEscalation({ duration: '12h 5m', category: 'transport_5xx', shortId: 'abcdef12' });
    expect(body).toContain('12h 5m');
    expect(body).toContain('transport_5xx');
    expect(body).toContain('abcdef12');
  });

  it('falls back to unstructured_403 on out-of-enum category', () => {
    const body = renderEscalation({ duration: '1h 0m', category: 'mystery' as never, shortId: '12345678' });
    expect(body).toContain('unstructured_403');
  });
});

describe('renderStampedeDigest', () => {
  it('renders the count as a string', () => {
    expect(renderStampedeDigest(7)).toContain('7 replies queued');
  });
});

describe('renderRecoveredMarker', () => {
  it('embeds the short id in the markdown-style monospace span', () => {
    const body = renderRecoveredMarker('cafebabe');
    expect(body).toContain('cafebabe');
    expect(body.startsWith('`')).toBe(true);
  });
});
