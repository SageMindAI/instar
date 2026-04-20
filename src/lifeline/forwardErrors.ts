/**
 * Typed errors thrown by forwardToServer so upstream (retry + orchestrator)
 * can tell transient failures from terminal ones and from version skew.
 *
 * Stage B: replaces the bare `Error(\`forward responded 426\`)` pattern that
 * couldn't be classified by retryWithBackoff.
 */

export class ForwardTransientError extends Error {
  readonly kind = 'transient' as const;
  constructor(public readonly status: number, message?: string) {
    super(message ?? `forward responded ${status}`);
    this.name = 'ForwardTransientError';
  }
}

export class ForwardBadRequestError extends Error {
  readonly kind = 'bad-request' as const;
  constructor(public readonly body?: unknown) {
    super('forward responded 400');
    this.name = 'ForwardBadRequestError';
  }
}

export class ForwardServerBootError extends Error {
  readonly kind = 'server-booting' as const;
  constructor(public readonly retryAfterMs: number = 1000) {
    super('forward responded 503 server-boot-incomplete');
    this.name = 'ForwardServerBootError';
  }
}

export interface VersionSkewBody {
  upgradeRequired?: boolean;
  serverVersion?: string;
  action?: string;
  reason?: string;
}

export class ForwardVersionSkewError extends Error {
  readonly kind = 'version-skew' as const;
  constructor(
    public readonly status: number,
    public readonly body: VersionSkewBody,
  ) {
    super(`forward responded 426 (server=${body.serverVersion ?? 'unknown'})`);
    this.name = 'ForwardVersionSkewError';
  }
}

export type ForwardError =
  | ForwardTransientError
  | ForwardBadRequestError
  | ForwardServerBootError
  | ForwardVersionSkewError;

/** True if the error classifies as terminal — retry MUST NOT re-attempt. */
export function isTerminalForwardError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const kind = (err as { kind?: string }).kind;
  return kind === 'version-skew' || kind === 'bad-request';
}
