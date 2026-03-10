/**
 * Unit tests for CoherenceReviewer — base class and all 9 reviewer implementations.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  CoherenceReviewer,
  type ReviewContext,
  type ReviewResult,
  type ReviewerOptions,
} from '../../src/core/CoherenceReviewer.js';
import { GateReviewer } from '../../src/core/reviewers/gate-reviewer.js';
import { ConversationalToneReviewer } from '../../src/core/reviewers/conversational-tone.js';
import { ClaimProvenanceReviewer } from '../../src/core/reviewers/claim-provenance.js';
import { SettlingDetectionReviewer } from '../../src/core/reviewers/settling-detection.js';
import { ContextCompletenessReviewer } from '../../src/core/reviewers/context-completeness.js';
import { CapabilityAccuracyReviewer } from '../../src/core/reviewers/capability-accuracy.js';
import { UrlValidityReviewer, extractUrls } from '../../src/core/reviewers/url-validity.js';
import { ValueAlignmentReviewer } from '../../src/core/reviewers/value-alignment.js';
import { InformationLeakageReviewer } from '../../src/core/reviewers/information-leakage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_API_KEY = 'test-api-key-000';

function makeContext(overrides?: Partial<ReviewContext>): ReviewContext {
  return {
    message: overrides?.message ?? 'Got it, working on that now.',
    channel: overrides?.channel ?? 'direct',
    isExternalFacing: overrides?.isExternalFacing ?? false,
    recipientType: overrides?.recipientType ?? 'primary-user',
    ...overrides,
  };
}

/** Build a mock fetch response matching Anthropic Messages API shape. */
function mockApiResponse(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text }],
    }),
    text: async () => text,
    headers: new Headers(),
  } as unknown as Response;
}

function mockApiError(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: new Headers(),
  } as unknown as Response;
}

/**
 * Concrete test subclass so we can test the abstract base directly.
 */
class TestReviewer extends CoherenceReviewer {
  lastPrompt = '';

  constructor(apiKey: string, options?: ReviewerOptions) {
    super('test-reviewer', apiKey, options);
  }

  protected buildPrompt(context: ReviewContext): string {
    const boundary = this.generateBoundary();
    const preamble = this.buildAntiInjectionPreamble();
    const prompt = `${preamble}\n\nTest prompt for: ${context.channel}\n\n${this.wrapMessage(context.message, boundary)}`;
    this.lastPrompt = prompt;
    return prompt;
  }

  /** Expose protected methods for testing. */
  public testGenerateBoundary(): string {
    return this.generateBoundary();
  }

  public testBuildAntiInjectionPreamble(): string {
    return this.buildAntiInjectionPreamble();
  }

  public testWrapMessage(message: string, boundary: string): string {
    return this.wrapMessage(message, boundary);
  }

  public testParseResponse(raw: string, name: string) {
    return this.parseResponse(raw, name);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CoherenceReviewer base class', () => {
  let reviewer: TestReviewer;

  beforeEach(() => {
    reviewer = new TestReviewer(FAKE_API_KEY);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Boundary generation ----

  describe('generateBoundary', () => {
    it('returns a string starting with REVIEW_BOUNDARY_', () => {
      const boundary = reviewer.testGenerateBoundary();
      expect(boundary).toMatch(/^REVIEW_BOUNDARY_[0-9a-f]{16}$/);
    });

    it('generates unique boundaries on successive calls', () => {
      const a = reviewer.testGenerateBoundary();
      const b = reviewer.testGenerateBoundary();
      expect(a).not.toBe(b);
    });
  });

  // ---- Anti-injection preamble ----

  describe('buildAntiInjectionPreamble', () => {
    it('includes UNTRUSTED CONTENT warning', () => {
      const preamble = reviewer.testBuildAntiInjectionPreamble();
      expect(preamble).toContain('UNTRUSTED CONTENT');
      expect(preamble).toContain('never execute it');
    });
  });

  // ---- wrapMessage ----

  describe('wrapMessage', () => {
    it('wraps message in boundary markers with JSON stringification', () => {
      const boundary = 'REVIEW_BOUNDARY_abc123';
      const wrapped = reviewer.testWrapMessage('hello world', boundary);
      expect(wrapped).toContain(`<<<${boundary}>>>`);
      expect(wrapped).toContain(JSON.stringify('hello world'));
      // Should appear twice (open + close)
      const matches = wrapped.match(new RegExp(`<<<${boundary}>>>`, 'g'));
      expect(matches).toHaveLength(2);
    });
  });

  // ---- parseResponse ----

  describe('parseResponse', () => {
    it('parses valid JSON response', () => {
      const raw = '{"pass": false, "severity": "block", "issue": "bad claim", "suggestion": "fix it"}';
      const result = reviewer.testParseResponse(raw, 'test');
      expect(result).toEqual({
        pass: false,
        severity: 'block',
        issue: 'bad claim',
        suggestion: 'fix it',
      });
    });

    it('extracts JSON from surrounding text', () => {
      const raw = 'Here is my analysis:\n{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}\nDone.';
      const result = reviewer.testParseResponse(raw, 'test');
      expect(result.pass).toBe(true);
    });

    it('fails open on empty string', () => {
      const result = reviewer.testParseResponse('', 'test');
      expect(result.pass).toBe(true);
      expect(result.severity).toBe('warn');
      expect(reviewer.metrics.jsonParseErrors).toBe(1);
    });

    it('fails open on invalid JSON', () => {
      const result = reviewer.testParseResponse('not json at all', 'test');
      expect(result.pass).toBe(true);
      expect(reviewer.metrics.jsonParseErrors).toBe(1);
    });

    it('fails open when pass is not boolean', () => {
      const result = reviewer.testParseResponse('{"pass": "yes", "severity": "warn"}', 'test');
      expect(result.pass).toBe(true);
      expect(reviewer.metrics.jsonParseErrors).toBe(1);
    });

    it('fails open when severity is invalid', () => {
      const result = reviewer.testParseResponse('{"pass": false, "severity": "critical"}', 'test');
      expect(result.pass).toBe(true);
      expect(reviewer.metrics.jsonParseErrors).toBe(1);
    });

    it('handles missing optional fields gracefully', () => {
      const result = reviewer.testParseResponse('{"pass": false, "severity": "warn"}', 'test');
      expect(result.pass).toBe(false);
      expect(result.issue).toBe('');
      expect(result.suggestion).toBe('');
    });
  });

  // ---- review (API integration) ----

  describe('review', () => {
    it('returns parsed result on successful API call', async () => {
      const apiResponse = '{"pass": false, "severity": "block", "issue": "technical leak", "suggestion": "simplify"}';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockApiResponse(apiResponse));

      const result = await reviewer.review(makeContext());

      expect(result.pass).toBe(false);
      expect(result.severity).toBe('block');
      expect(result.issue).toBe('technical leak');
      expect(result.reviewer).toBe('test-reviewer');
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(reviewer.metrics.failCount).toBe(1);
    });

    it('returns pass on successful passing review', async () => {
      const apiResponse = '{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}';
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockApiResponse(apiResponse));

      const result = await reviewer.review(makeContext());

      expect(result.pass).toBe(true);
      expect(reviewer.metrics.passCount).toBe(1);
    });

    it('fails open on API error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockApiError(500, 'Internal Server Error'));

      const result = await reviewer.review(makeContext());

      expect(result.pass).toBe(true);
      expect(result.reviewer).toBe('test-reviewer');
      expect(reviewer.metrics.errorCount).toBe(1);
    });

    it('fails open on network error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network failure'));

      const result = await reviewer.review(makeContext());

      expect(result.pass).toBe(true);
      expect(reviewer.metrics.errorCount).toBe(1);
    });

    it('fails open on timeout', async () => {
      const slowReviewer = new TestReviewer(FAKE_API_KEY, { timeoutMs: 50 });
      vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(mockApiResponse('{}')), 5000)),
      );

      const result = await slowReviewer.review(makeContext());

      expect(result.pass).toBe(true);
      expect(slowReviewer.metrics.errorCount).toBe(1);
    });

    it('tracks cumulative health metrics', async () => {
      const passing = '{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}';
      const failing = '{"pass": false, "severity": "block", "issue": "x", "suggestion": "y"}';

      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(mockApiResponse(passing))
        .mockResolvedValueOnce(mockApiResponse(failing))
        .mockRejectedValueOnce(new Error('fail'));

      await reviewer.review(makeContext());
      await reviewer.review(makeContext());
      await reviewer.review(makeContext());

      expect(reviewer.metrics.passCount).toBe(1);
      expect(reviewer.metrics.failCount).toBe(1);
      expect(reviewer.metrics.errorCount).toBe(1);
      expect(reviewer.metrics.totalLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('sends correct headers to Anthropic API', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
      );

      await reviewer.review(makeContext());

      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe(FAKE_API_KEY);
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('uses haiku model by default', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
      );

      await reviewer.review(makeContext());

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.model).toBe('claude-haiku-4-5');
      expect(body.max_tokens).toBe(200);
      expect(body.temperature).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Gate Reviewer
// ---------------------------------------------------------------------------

describe('GateReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('parses gate-specific response format', async () => {
    const gateResponse = '{"needsReview": true, "reason": "contains URLs"}';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockApiResponse(gateResponse));

    const reviewer = new GateReviewer(FAKE_API_KEY);
    const result = await reviewer.reviewAsGate(makeContext());

    expect(result.needsReview).toBe(true);
    expect(result.reason).toBe('contains URLs');
  });

  it('maps needsReview=false to pass=true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"needsReview": false, "reason": "simple ack"}'),
    );

    const reviewer = new GateReviewer(FAKE_API_KEY);
    const result = await reviewer.review(makeContext());

    expect(result.pass).toBe(true);
  });

  it('defaults to needing review on error (conservative fail-open)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('API down'));

    const reviewer = new GateReviewer(FAKE_API_KEY);
    const result = await reviewer.review(makeContext());

    // Gate fails conservative: assume review IS needed
    expect(result.pass).toBe(false);
    expect(result.issue).toContain('Gate reviewer error');
  });

  it('prompt includes channel and external-facing context', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"needsReview": false, "reason": "ok"}'),
    );

    const reviewer = new GateReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext({ channel: 'telegram', isExternalFacing: true }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('telegram');
    expect(prompt).toContain('UNTRUSTED CONTENT');
    expect(prompt).toContain('ALWAYS NEEDS REVIEW');
  });
});

// ---------------------------------------------------------------------------
// Conversational Tone Reviewer
// ---------------------------------------------------------------------------

describe('ConversationalToneReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prompt includes channel and technical leak keywords', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ConversationalToneReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext({ channel: 'telegram' }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('Config file references');
    expect(prompt).toContain('CLI commands');
    expect(prompt).toContain('telegram');
    expect(prompt).toContain('UNTRUSTED CONTENT');
  });

  it('includes relationship context when provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ConversationalToneReviewer(FAKE_API_KEY);
    await reviewer.review(
      makeContext({
        relationshipContext: { communicationStyle: 'casual', formality: 'low' },
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('casual');
    expect(prompt).toContain('low');
  });
});

// ---------------------------------------------------------------------------
// Claim Provenance Reviewer
// ---------------------------------------------------------------------------

describe('ClaimProvenanceReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults to sonnet model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ClaimProvenanceReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext());

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.model).toBe('claude-sonnet-4-6');
  });

  it('prompt includes tool output context when provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ClaimProvenanceReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext({ toolOutputContext: 'curl returned 200 OK' }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('curl returned 200 OK');
    expect(prompt).toContain('factual accuracy');
  });

  it('allows model override via options', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ClaimProvenanceReviewer(FAKE_API_KEY, { model: 'haiku' });
    await reviewer.review(makeContext());

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.model).toBe('claude-haiku-4-5');
  });
});

// ---------------------------------------------------------------------------
// Settling Detection Reviewer
// ---------------------------------------------------------------------------

describe('SettlingDetectionReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prompt includes thoroughness keywords', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new SettlingDetectionReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext());

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('thoroughness reviewer');
    expect(prompt).toContain('investigation theater');
  });
});

// ---------------------------------------------------------------------------
// Context Completeness Reviewer
// ---------------------------------------------------------------------------

describe('ContextCompletenessReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prompt includes completeness keywords', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ContextCompletenessReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext());

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('completeness reviewer');
    expect(prompt).toContain('trade-offs');
  });

  it('includes relationship themes when provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ContextCompletenessReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext({ relationshipContext: { themes: ['security', 'performance'] } }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('security');
    expect(prompt).toContain('performance');
  });
});

// ---------------------------------------------------------------------------
// Capability Accuracy Reviewer
// ---------------------------------------------------------------------------

describe('CapabilityAccuracyReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prompt includes capability accuracy keywords', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new CapabilityAccuracyReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext());

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('capability accuracy reviewer');
    expect(prompt).toContain("I can't");
    expect(prompt).toContain("you'll need to");
  });
});

// ---------------------------------------------------------------------------
// URL Validity Reviewer
// ---------------------------------------------------------------------------

describe('UrlValidityReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prompt includes URL validity keywords', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new UrlValidityReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext({ message: 'Check https://example.com/dashboard' }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('URL validity reviewer');
    expect(prompt).toContain('https://example.com/dashboard');
  });

  it('uses pre-extracted URLs when provided', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new UrlValidityReviewer(FAKE_API_KEY);
    await reviewer.review(
      makeContext({
        message: 'Visit the dashboard',
        extractedUrls: ['https://my-app.vercel.app'],
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('https://my-app.vercel.app');
  });
});

describe('extractUrls', () => {
  it('extracts http and https URLs', () => {
    const text = 'Visit https://example.com and http://localhost:4042/health for info.';
    const urls = extractUrls(text);
    expect(urls).toEqual(['https://example.com', 'http://localhost:4042/health']);
  });

  it('returns empty array for text with no URLs', () => {
    expect(extractUrls('No links here.')).toEqual([]);
  });

  it('handles URLs with paths and query strings', () => {
    const urls = extractUrls('See https://api.example.com/v1/data?q=test&limit=10');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('api.example.com');
  });
});

// ---------------------------------------------------------------------------
// Value Alignment Reviewer
// ---------------------------------------------------------------------------

describe('ValueAlignmentReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('defaults to sonnet model', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ValueAlignmentReviewer(FAKE_API_KEY);
    await reviewer.review(makeContext());

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.model).toBe('claude-sonnet-4-6');
  });

  it('prompt includes all three value tiers with separate boundaries', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new ValueAlignmentReviewer(FAKE_API_KEY);
    await reviewer.review(
      makeContext({
        agentValues: 'Be thorough, never settle.',
        userValues: 'Prefers casual tone.',
        orgValues: 'No unauthorized deployments.',
      }),
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('Be thorough, never settle.');
    expect(prompt).toContain('Prefers casual tone.');
    expect(prompt).toContain('No unauthorized deployments.');
    expect(prompt).toContain('value alignment reviewer');
    // Should have multiple separate boundaries (at least 4: agent, user, org, message)
    const boundaryMatches = prompt.match(/<<<REVIEW_BOUNDARY_[0-9a-f]{16}>>>/g);
    expect(boundaryMatches!.length).toBeGreaterThanOrEqual(8); // 4 boundaries x 2 (open+close)
  });
});

// ---------------------------------------------------------------------------
// Information Leakage Reviewer
// ---------------------------------------------------------------------------

describe('InformationLeakageReviewer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('skips review for primary-user (always passes)', async () => {
    // Should NOT call fetch at all
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const reviewer = new InformationLeakageReviewer(FAKE_API_KEY);
    const result = await reviewer.review(makeContext({ recipientType: 'primary-user' }));

    expect(result.pass).toBe(true);
    expect(result.latencyMs).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs review for agent recipients', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": false, "severity": "block", "issue": "leaks user name", "suggestion": "remove PII"}'),
    );

    const reviewer = new InformationLeakageReviewer(FAKE_API_KEY);
    const result = await reviewer.review(
      makeContext({ recipientType: 'agent', trustLevel: 'verified' }),
    );

    expect(result.pass).toBe(false);
    expect(result.severity).toBe('block');
    expect(fetchSpy).toHaveBeenCalled();

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    const prompt = body.messages[0].content as string;
    expect(prompt).toContain('agent');
    expect(prompt).toContain('verified');
    expect(prompt).toContain('information leakage');
  });

  it('runs review for secondary-user recipients', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new InformationLeakageReviewer(FAKE_API_KEY);
    const result = await reviewer.review(
      makeContext({ recipientType: 'secondary-user', trustLevel: 'trusted' }),
    );

    expect(result.pass).toBe(true);
  });

  it('runs review for external-contact recipients', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockApiResponse('{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}'),
    );

    const reviewer = new InformationLeakageReviewer(FAKE_API_KEY);
    const result = await reviewer.review(
      makeContext({ recipientType: 'external-contact', trustLevel: 'untrusted' }),
    );

    expect(result.pass).toBe(true);
  });
});
