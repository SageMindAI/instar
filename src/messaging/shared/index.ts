export { SHARED_INFRA_FLAGS } from './FeatureFlags.js';
export { MessageLogger } from './MessageLogger.js';
export type { LogEntry, TelegramLogEntry, MessageLoggerConfig, OnMessageLoggedCallback } from './MessageLogger.js';
export { SessionChannelRegistry } from './SessionChannelRegistry.js';
export type { ChannelMapping, SessionChannelRegistryConfig } from './SessionChannelRegistry.js';
export { StallDetector } from './StallDetector.js';
export type {
  PendingMessage, PendingPromise, StallEvent, StallDetectorConfig,
  IsSessionAliveCheck, IsSessionActiveCheck, OnStallCallback,
} from './StallDetector.js';
export { CommandRouter } from './CommandRouter.js';
export type { CommandContext, CommandHandler } from './CommandRouter.js';
export { AuthGate } from './AuthGate.js';
export type {
  AuthGateConfig, RegistrationPolicy, UnknownUserInfo,
  AuthResult, AuthGateCallbacks,
} from './AuthGate.js';
export { MessagingEventBus } from './MessagingEventBus.js';
export type {
  MessagingEventMap, MessagingEventName, EventListener,
  IncomingMessageEvent, MessageLoggedEvent, StallDetectedEvent,
  PromiseExpiredEvent, SessionInterruptRequest, SessionRestartRequest,
  CommandExecutedEvent, UnauthorizedUserEvent, AttentionStatusEvent,
  FlushRequestEvent, QuotaRequestEvent, SwitchAccountRequestEvent,
  LoginRequestEvent,
} from './MessagingEventBus.js';
export { smartChunk } from './SmartChunker.js';
export { normalizePhoneNumber, phoneToJid, jidToPhone, isJid, isGroupJid } from './PhoneUtils.js';
export { PrivacyConsent } from './PrivacyConsent.js';
export type { ConsentRecord, PrivacyConsentOptions } from './PrivacyConsent.js';
export {
  encryptData, decryptData, isEncryptedFile, readAuthFile, writeAuthFile,
  useEncryptedAuthState,
} from './EncryptedAuthStore.js';
export type { EncryptedAuthStoreOptions } from './EncryptedAuthStore.js';
