/**
 * MoltBridge HTTP routes — Server endpoints for MoltBridge integration.
 *
 * These routes proxy through the MoltBridgeClient (which wraps the real SDK):
 * - POST /moltbridge/register — Register agent with MoltBridge
 * - POST /moltbridge/discover — Capability-based discovery
 * - GET /moltbridge/trust/:agentId — Get IQS band (cached)
 * - POST /moltbridge/attest — Submit peer attestation
 * - GET /moltbridge/status — Health + registration check
 */

import { Router, type Request, type Response } from 'express';
import type { MoltBridgeClient } from './MoltBridgeClient.js';
import type { CanonicalIdentityManager } from '../identity/IdentityManager.js';
import type { RichProfilePayload } from './types.js';
import { PROFILE_LIMITS } from './types.js';
import type { ProfileCompiler } from './ProfileCompiler.js';

export interface MoltBridgeRouteDeps {
  client: MoltBridgeClient;
  identity: CanonicalIdentityManager;
  profileCompiler?: ProfileCompiler;
}

export function createMoltBridgeRoutes(deps: MoltBridgeRouteDeps): Router {
  const router = Router();
  const { client, identity, profileCompiler } = deps;

  // POST /moltbridge/register
  router.post('/moltbridge/register', async (req: Request, res: Response) => {
    try {
      const id = identity.get();
      if (!id) {
        res.status(500).json({ error: 'No canonical identity available' });
        return;
      }

      if (!client.initialized) {
        client.initializeWithIdentity(id);
      }

      const result = await client.register(
        id,
        req.body.capabilities ?? [],
        req.body.displayName,
      );
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_UNAVAILABLE', message: String(err) },
      });
    }
  });

  // POST /moltbridge/discover
  router.post('/moltbridge/discover', async (req: Request, res: Response) => {
    try {
      const { capability, limit } = req.body;
      if (!capability) {
        res.status(400).json({ error: 'capability is required' });
        return;
      }
      const result = await client.discover(capability, limit);
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_DISCOVERY_FAILED', message: String(err) },
      });
    }
  });

  // GET /moltbridge/trust/:agentId
  router.get('/moltbridge/trust/:agentId', async (req: Request, res: Response) => {
    try {
      const band = await client.getIQSBand(req.params.agentId);
      res.json({ agentId: req.params.agentId, iqsBand: band ?? 'unknown' });
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_TRUST_QUERY_FAILED', message: String(err) },
      });
    }
  });

  // POST /moltbridge/attest
  router.post('/moltbridge/attest', async (req: Request, res: Response) => {
    try {
      const { targetAgentId, attestationType, capabilityTag, confidence } = req.body;
      if (!targetAgentId || !attestationType) {
        res.status(400).json({ error: 'targetAgentId and attestationType are required' });
        return;
      }

      if (!['CAPABILITY', 'IDENTITY', 'INTERACTION'].includes(attestationType)) {
        res.status(400).json({
          error: { code: 'INVALID_ATTESTATION_TYPE', message: 'attestationType must be CAPABILITY, IDENTITY, or INTERACTION' },
        });
        return;
      }

      await client.submitAttestation({
        targetAgentId,
        attestationType,
        capabilityTag,
        confidence: confidence ?? 0.8,
      });
      res.json({ submitted: true });
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_ATTESTATION_FAILED', message: String(err) },
      });
    }
  });

  // ── Rich Profile Routes ────────────────────────────────────────

  // POST /moltbridge/profile — Publish rich profile
  router.post('/moltbridge/profile', async (req: Request, res: Response) => {
    try {
      const profile = req.body as RichProfilePayload;
      if (!profile.narrative) {
        res.status(400).json({ error: 'narrative is required' });
        return;
      }
      if (profile.narrative.length > PROFILE_LIMITS.narrativeMaxChars) {
        res.status(400).json({ error: `narrative exceeds ${PROFILE_LIMITS.narrativeMaxChars} chars` });
        return;
      }
      const result = await client.publishProfile(profile);
      res.json({ published: true, profile: result });
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_PROFILE_PUBLISH_FAILED', message: String(err) },
      });
    }
  });

  // GET /moltbridge/profile — Get own full profile
  router.get('/moltbridge/profile', async (_req: Request, res: Response) => {
    try {
      const result = await client.getProfile();
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_PROFILE_FETCH_FAILED', message: String(err) },
      });
    }
  });

  // GET /moltbridge/profile/summary — Get public discovery card
  router.get('/moltbridge/profile/summary', async (_req: Request, res: Response) => {
    try {
      const result = await client.getProfileSummary();
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: { code: 'MOLTBRIDGE_PROFILE_SUMMARY_FAILED', message: String(err) },
      });
    }
  });

  // POST /moltbridge/profile/compile — Trigger profile compilation from agent data
  router.post('/moltbridge/profile/compile', async (_req: Request, res: Response) => {
    try {
      if (!profileCompiler) {
        res.status(501).json({ error: 'Profile compiler not configured' });
        return;
      }
      const draft = await profileCompiler.compile();
      res.json({ draft });
    } catch (err) {
      res.status(500).json({
        error: { code: 'PROFILE_COMPILATION_FAILED', message: String(err) },
      });
    }
  });

  // POST /moltbridge/profile/approve — Approve a compiled draft and publish
  router.post('/moltbridge/profile/approve', async (req: Request, res: Response) => {
    try {
      if (!profileCompiler) {
        res.status(501).json({ error: 'Profile compiler not configured' });
        return;
      }
      const draft = profileCompiler.getCurrentDraft();
      if (!draft || draft.status !== 'pending') {
        res.status(400).json({ error: 'No pending draft to approve' });
        return;
      }
      draft.status = 'approved';
      draft.approvedAt = new Date().toISOString();
      draft.approvedBy = 'human';

      const result = await client.publishProfile(draft.profile);
      profileCompiler.markPublished();
      res.json({ published: true, profile: result });
    } catch (err) {
      res.status(502).json({
        error: { code: 'PROFILE_APPROVAL_FAILED', message: String(err) },
      });
    }
  });

  // GET /moltbridge/profile/draft — Get current compilation draft
  router.get('/moltbridge/profile/draft', async (_req: Request, res: Response) => {
    if (!profileCompiler) {
      res.status(501).json({ error: 'Profile compiler not configured' });
      return;
    }
    const draft = profileCompiler.getCurrentDraft();
    res.json({ draft: draft ?? null });
  });

  // GET /moltbridge/status
  router.get('/moltbridge/status', async (_req: Request, res: Response) => {
    try {
      if (!client.enabled) {
        res.json({ enabled: false, healthy: false, reason: 'MoltBridge disabled in config' });
        return;
      }

      if (!client.initialized) {
        const id = identity.get();
        if (!id) {
          res.json({ enabled: true, healthy: false, reason: 'No canonical identity' });
          return;
        }
        client.initializeWithIdentity(id);
      }

      const health = await client.health();
      res.json({
        enabled: true,
        healthy: health.status === 'healthy',
        serverStatus: health.status,
        neo4j: health.neo4j,
        circuitBreakerOpen: client.isCircuitBreakerOpen,
      });
    } catch (err) {
      res.json({
        enabled: true,
        healthy: false,
        reason: String(err),
        circuitBreakerOpen: client.isCircuitBreakerOpen,
      });
    }
  });

  return router;
}
