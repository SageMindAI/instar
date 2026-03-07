/**
 * AdapterRegistry — Factory pattern for messaging adapters.
 *
 * Replaces hardcoded adapter creation in server.ts with a registry that
 * any adapter type can register into. Future-proofs for community-contributed
 * adapters (Discord, Slack, etc.)
 */

import type { MessagingAdapter } from '../core/types.js';

type AdapterConstructor = new (config: Record<string, unknown>, stateDir: string) => MessagingAdapter;

const registry = new Map<string, AdapterConstructor>();

/** Register an adapter type. Call at module load time. */
export function registerAdapter(type: string, ctor: AdapterConstructor): void {
  if (registry.has(type)) {
    console.warn(`[adapter-registry] Overwriting existing adapter type: ${type}`);
  }
  registry.set(type, ctor);
}

/** Create an adapter instance from config. Throws if type is unknown. */
export function createAdapter(
  config: { type: string; enabled: boolean; config: Record<string, unknown> },
  stateDir: string,
): MessagingAdapter {
  const Ctor = registry.get(config.type);
  if (!Ctor) {
    throw new Error(
      `Unknown messaging adapter: "${config.type}". Available: ${[...registry.keys()].join(', ') || 'none'}`,
    );
  }
  return new Ctor(config.config, stateDir);
}

/** Check if an adapter type is registered. */
export function hasAdapter(type: string): boolean {
  return registry.has(type);
}

/** Get all registered adapter type names. */
export function getRegisteredAdapters(): string[] {
  return [...registry.keys()];
}

/** Remove an adapter registration (mainly for testing). */
export function unregisterAdapter(type: string): boolean {
  return registry.delete(type);
}

/** Clear all registrations (mainly for testing). */
export function clearRegistry(): void {
  registry.clear();
}
