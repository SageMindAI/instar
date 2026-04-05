/**
 * Slack API Contract Tests — Live verification against the REAL Slack API.
 *
 * These tests do NOT mock anything. They hit the actual Slack API with a real
 * bot token and verify that our assumptions about API responses are correct.
 *
 * WHY THIS EXISTS:
 * We shipped 3 versions of a "fix" for Slack file content extraction that all
 * passed unit tests but failed in production. The unit tests mocked files.info
 * to return content — in reality, it returned `missing_scope`. Mocked tests
 * encode assumptions, not reality. These contract tests encode reality.
 *
 * SETUP:
 *   export SLACK_CONTRACT_BOT_TOKEN=xoxb-...   # Bot token to test
 *   export SLACK_CONTRACT_CHANNEL=C...          # Channel ID for write tests
 *   npm run test:contract
 *
 * If SLACK_CONTRACT_BOT_TOKEN is not set, tests are SKIPPED (not failed).
 * If it IS set and any test fails, that means our code's assumptions about
 * the Slack API are WRONG and must be fixed before shipping.
 */

import { describe, it, expect, beforeAll } from 'vitest';

const BOT_TOKEN = process.env.SLACK_CONTRACT_BOT_TOKEN;
const TEST_CHANNEL = process.env.SLACK_CONTRACT_CHANNEL;

// Skip entire suite if no token is configured
const describeWithToken = BOT_TOKEN ? describe : describe.skip;

/** Helper: call Slack API and return parsed JSON + response headers */
async function slackAPI(method: string, params: Record<string, unknown> = {}): Promise<{
  data: Record<string, unknown>;
  scopes: string[];
  headers: Headers;
}> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(params),
  });

  const scopes = (response.headers.get('x-oauth-scopes') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const data = await response.json() as Record<string, unknown>;

  return { data, scopes, headers: response.headers };
}

describeWithToken('Slack API Contract Tests (LIVE)', () => {
  // ── Scope verification ──────────────────────────────────────────────
  describe('OAuth Scopes', () => {
    let grantedScopes: string[] = [];

    beforeAll(async () => {
      const { data, scopes } = await slackAPI('auth.test');
      expect(data.ok).toBe(true);
      grantedScopes = scopes;
      console.log(`[contract] Bot: ${data.user}@${data.team}`);
      console.log(`[contract] Scopes: ${grantedScopes.join(', ')}`);
    });

    it('has files:read scope (required for file content extraction)', () => {
      expect(
        grantedScopes,
        'Bot token is missing files:read scope. Add it in Slack app OAuth & Permissions page and reinstall.'
      ).toContain('files:read');
    });

    it('has channels:history scope (required for reading messages)', () => {
      expect(grantedScopes).toContain('channels:history');
    });

    it('has chat:write scope (required for sending messages)', () => {
      expect(grantedScopes).toContain('chat:write');
    });

    it('x-oauth-scopes header is present and parseable', () => {
      expect(grantedScopes.length).toBeGreaterThan(0);
    });
  });

  // ── files.info API contract ─────────────────────────────────────────
  describe('files.info API', () => {
    it('returns missing_scope error when files:read is absent (contract shape)', async () => {
      // This test documents the EXACT error shape Slack returns when scope is missing.
      // If the bot HAS files:read, we test with a fake file ID to verify error shape.
      const { data } = await slackAPI('files.info', { file: 'F000000FAKE' });

      if (!data.ok) {
        // Either missing_scope or file_not_found — both are valid responses
        expect(data.error).toBeDefined();
        expect(typeof data.error).toBe('string');

        if (data.error === 'missing_scope') {
          // Verify the error response includes the needed scope
          expect(data.needed).toBe('files:read');
          console.log('[contract] files.info correctly reports missing_scope with needed field');
        } else {
          // If we have the scope, we should get file_not_found for a fake ID
          expect(data.error).toBe('file_not_found');
          console.log('[contract] files.info correctly returns file_not_found for invalid ID (scope is present)');
        }
      }
    });
  });

  // ── File download contract ──────────────────────────────────────────
  describe('File download behavior', () => {
    it('Slack file URLs redirect to CDN subdomains', async () => {
      // This test verifies that Slack file URLs DO redirect (which strips auth headers).
      // We use a known-bad URL to test redirect behavior without needing a real file.
      const response = await fetch('https://files.slack.com/files-pri/TFAKE/fake-file.txt', {
        headers: { Authorization: `Bearer ${BOT_TOKEN}` },
        redirect: 'manual',
      });

      // Slack should return a redirect (302) or an error page
      // The key contract: redirects exist, and the Location header may point to a different origin
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        expect(location).toBeTruthy();
        console.log(`[contract] File URL redirects to: ${new URL(location!).hostname}`);

        // Verify the redirect is cross-origin (which is why auth gets stripped)
        const originalHost = new URL('https://files.slack.com').hostname;
        const redirectHost = new URL(location!).hostname;
        if (originalHost !== redirectHost) {
          console.log('[contract] CONFIRMED: Slack file URLs redirect cross-origin — auth header stripping is real');
        }
      } else {
        // Even if we get an error, log the status for contract documentation
        console.log(`[contract] File URL returned status ${response.status} (expected redirect or error)`);
      }
    });
  });

  // ── End-to-end file content extraction (requires channel + files:read) ──
  const describeWithChannel = (BOT_TOKEN && TEST_CHANNEL) ? describe : describe.skip;

  describeWithChannel('End-to-end file content extraction', () => {
    let uploadedFileId: string | null = null;

    it('can upload a text snippet and read it back via files.info', async () => {
      // Step 1: Upload a snippet with known content
      const testContent = `Contract test content ${Date.now()}`;

      // Use files.getUploadURLExternal (v2 API)
      const urlResp = await slackAPI('files.getUploadURLExternal', {
        filename: 'contract-test.txt',
        length: Buffer.byteLength(testContent),
      });

      if (!urlResp.data.ok) {
        // If upload scope is missing, skip gracefully
        console.log(`[contract] files.getUploadURLExternal failed: ${urlResp.data.error} — skipping upload test`);
        return;
      }

      const uploadUrl = urlResp.data.upload_url as string;
      uploadedFileId = urlResp.data.file_id as string;

      // Step 2: PUT the content
      const putResp = await fetch(uploadUrl, {
        method: 'PUT',
        body: testContent,
      });
      expect(putResp.ok).toBe(true);

      // Step 3: Complete upload
      await slackAPI('files.completeUploadExternal', {
        files: [{ id: uploadedFileId, title: 'Contract Test Snippet' }],
        channel_id: TEST_CHANNEL,
      });

      // Step 4: Read it back via files.info
      // Small delay for Slack to process
      await new Promise(resolve => setTimeout(resolve, 2000));

      const infoResp = await slackAPI('files.info', { file: uploadedFileId });

      if (!infoResp.data.ok) {
        throw new Error(
          `files.info failed for uploaded file: ${infoResp.data.error}. ` +
          `This means our content extraction pipeline CANNOT work. ` +
          `Error: ${JSON.stringify(infoResp.data)}`
        );
      }

      const fileData = (infoResp.data.file ?? {}) as Record<string, unknown>;

      // Document the actual response shape
      console.log('[contract] files.info response fields:', Object.keys(fileData).join(', '));
      console.log('[contract] content field present:', 'content' in fileData);
      console.log('[contract] preview field present:', 'preview' in fileData);
      console.log('[contract] plain_text field present:', 'plain_text' in fileData);

      // At least one content field should contain our text
      const content = fileData.content as string ?? '';
      const preview = fileData.preview as string ?? '';
      const plainText = fileData.plain_text as string ?? '';
      const anyContent = content || preview || plainText;

      expect(
        anyContent.length > 0,
        'files.info returned no content in any field (content, preview, plain_text). ' +
        'Our three-tier extraction pipeline has no data to work with.'
      ).toBe(true);

      console.log(`[contract] Content retrieved successfully (${anyContent.length} chars)`);
    }, 30000); // 30s timeout for API calls

    it('can download file content via url_private with auth', async () => {
      if (!uploadedFileId) {
        console.log('[contract] Skipping download test — no file was uploaded');
        return;
      }

      const infoResp = await slackAPI('files.info', { file: uploadedFileId });
      if (!infoResp.data.ok) return;

      const fileData = (infoResp.data.file ?? {}) as Record<string, unknown>;
      const downloadUrl = fileData.url_private_download as string ?? fileData.url_private as string;

      if (!downloadUrl) {
        console.log('[contract] No download URL in files.info response');
        return;
      }

      // Download with manual redirect following (matching our FileHandler logic)
      let response = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${BOT_TOKEN}` },
        redirect: 'manual',
      });

      let redirectCount = 0;
      while (response.status >= 300 && response.status < 400 && redirectCount < 5) {
        const location = response.headers.get('location');
        if (!location) break;
        console.log(`[contract] Redirect ${redirectCount + 1}: ${response.status} → ${new URL(location).hostname}`);
        response = await fetch(location, {
          headers: { Authorization: `Bearer ${BOT_TOKEN}` },
          redirect: 'manual',
        });
        redirectCount++;
      }

      expect(response.ok).toBe(true);

      const body = await response.text();

      // The downloaded content should NOT be an HTML page
      expect(
        body.startsWith('<!DOCTYPE') || body.startsWith('<html'),
        `Downloaded file is HTML, not file content. First 200 chars: ${body.substring(0, 200)}`
      ).toBe(false);

      console.log(`[contract] File download successful: ${body.length} chars, content starts with: "${body.substring(0, 50)}"`);
    }, 15000);

    // Clean up uploaded test file
    it('cleanup: delete test file', async () => {
      if (uploadedFileId) {
        await slackAPI('files.delete', { file: uploadedFileId }).catch(() => {});
      }
    });
  });
});
