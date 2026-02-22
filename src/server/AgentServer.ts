/**
 * Agent Server — HTTP server wrapping Express.
 *
 * Provides health checks, session management, job triggering,
 * and event querying over a simple REST API.
 */

import express, { type Express } from 'express';
import type { Server } from 'node:http';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { InstarConfig } from '../core/types.js';
import type { RelationshipManager } from '../core/RelationshipManager.js';
import type { FeedbackManager } from '../core/FeedbackManager.js';
import type { DispatchManager } from '../core/DispatchManager.js';
import type { UpdateChecker } from '../core/UpdateChecker.js';
import type { AutoUpdater } from '../core/AutoUpdater.js';
import type { QuotaTracker } from '../monitoring/QuotaTracker.js';
import type { TelegraphService } from '../publishing/TelegraphService.js';
import type { PrivateViewer } from '../publishing/PrivateViewer.js';
import type { TunnelManager } from '../tunnel/TunnelManager.js';
import type { EvolutionManager } from '../core/EvolutionManager.js';
import { createRoutes } from './routes.js';
import { corsMiddleware, authMiddleware, requestTimeout, errorHandler } from './middleware.js';

export class AgentServer {
  private app: Express;
  private server: Server | null = null;
  private config: InstarConfig;
  private startTime: Date;

  constructor(options: {
    config: InstarConfig;
    sessionManager: SessionManager;
    state: StateManager;
    scheduler?: JobScheduler;
    telegram?: TelegramAdapter;
    relationships?: RelationshipManager;
    feedback?: FeedbackManager;
    dispatches?: DispatchManager;
    updateChecker?: UpdateChecker;
    autoUpdater?: AutoUpdater;
    quotaTracker?: QuotaTracker;
    publisher?: TelegraphService;
    viewer?: PrivateViewer;
    tunnel?: TunnelManager;
    evolution?: EvolutionManager;
  }) {
    this.config = options.config;
    this.startTime = new Date();
    this.app = express();

    // Middleware
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(corsMiddleware);
    this.app.use(authMiddleware(options.config.authToken));
    this.app.use(requestTimeout(options.config.requestTimeoutMs));

    // Routes
    const routes = createRoutes({
      config: options.config,
      sessionManager: options.sessionManager,
      state: options.state,
      scheduler: options.scheduler ?? null,
      telegram: options.telegram ?? null,
      relationships: options.relationships ?? null,
      feedback: options.feedback ?? null,
      dispatches: options.dispatches ?? null,
      updateChecker: options.updateChecker ?? null,
      autoUpdater: options.autoUpdater ?? null,
      quotaTracker: options.quotaTracker ?? null,
      publisher: options.publisher ?? null,
      viewer: options.viewer ?? null,
      tunnel: options.tunnel ?? null,
      evolution: options.evolution ?? null,
      startTime: this.startTime,
    });
    this.app.use(routes);

    // Error handler (must be last)
    this.app.use(errorHandler);
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const host = this.config.host || '127.0.0.1';
      this.server = this.app.listen(this.config.port, host, () => {
        console.log(`[instar] Server listening on ${host}:${this.config.port}`);
        resolve();
      });
      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${this.config.port} is already in use. Is another instar server running?`));
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Stop the HTTP server gracefully.
   * Closes keep-alive connections after a timeout to prevent hanging.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceTimer);
        this.server = null;
        resolve();
      };

      // Force-close after 5 seconds if graceful close hangs (keep-alive connections)
      const forceTimer = setTimeout(() => {
        console.log('[instar] Force-closing server (keep-alive timeout)');
        this.server?.closeAllConnections?.();
        done();
      }, 5000);
      forceTimer.unref(); // Don't prevent process exit during shutdown

      this.server.close(() => done());
    });
  }

  /**
   * Expose the Express app for testing with supertest.
   */
  getApp(): Express {
    return this.app;
  }
}
