/**
 * iMessage messaging adapter — entry point and registry registration.
 */

export { IMessageAdapter } from './IMessageAdapter.js';
export { NativeBackend } from './NativeBackend.js';
export { OutboundRateLimiter } from './OutboundRateLimiter.js';
export { OutboundAuditLog } from './OutboundAuditLog.js';
export { normalizeIdentifier, normalizeIdentifierSet, identifiersMatch } from './normalize-phone.js';
export type {
  IMessageConfig,
  IMessageIncoming,
  IMessageAttachment,
  IMessageChat,
  ConnectionState,
  ConnectionInfo,
} from './types.js';

// Register with the adapter registry at module load time
import { registerAdapter } from '../AdapterRegistry.js';
import { IMessageAdapter } from './IMessageAdapter.js';

registerAdapter('imessage', IMessageAdapter);
