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

export interface MoltBridgeRouteDeps {
  client: MoltBridgeClient;
  identity: CanonicalIdentityManager;
}

export function createMoltBridgeRoutes(deps: MoltBridgeRouteDeps): Router {
  const router = Router();
  const { client, identity } = deps;

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
