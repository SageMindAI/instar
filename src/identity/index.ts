/**
 * Identity module — Public API.
 *
 * Canonical agent identity management for Instar agents.
 */

// Types and constants
export {
  computeCanonicalId,
  computeDisplayFingerprint,
  CANONICAL_ID_DOMAIN,
  IDENTITY_SCHEMA_VERSION,
  DISPLAY_FINGERPRINT_BYTES,
  DEFAULT_GRANT_TTL_MS,
  TRUST_DECAY,
  KEY_ROTATION_GRACE_MS,
  RECOVERY_TIMELOCK_MS,
  MAX_RECOVERY_ATTEMPTS,
  MIGRATION_DEADLINE_MS,
  type CanonicalIdentity,
  type IdentityFile,
  type PrivateKeyEncryption,
  type RotationProof,
  type RevocationRequest,
} from './types.js';

// Identity manager
export {
  CanonicalIdentityManager,
  type CreateIdentityOptions,
  type CreateIdentityResult,
  type LoadIdentityOptions,
} from './IdentityManager.js';

// Key encryption
export {
  encryptPrivateKey,
  decryptPrivateKey,
  generateSalt,
  SALT_BYTES,
} from './KeyEncryption.js';

// Recovery phrase
export {
  generateRecoveryPhrase,
  isValidRecoveryPhrase,
  deriveRecoveryKeypair,
  createRecoveryCommitment,
  verifyRecoveryCommitment,
  generateRecoverySalt,
} from './RecoveryPhrase.js';

// Key rotation
export {
  createRotation,
  verifyRotationProof,
  isWithinGracePeriod,
  computeRotatedCanonicalId,
} from './KeyRotation.js';

// Key revocation
export {
  RevocationManager,
  type RevocationAuditEntry,
  type RevocationState,
} from './KeyRevocation.js';

// Migration
export {
  hasLegacyIdentity,
  hasCanonicalIdentity,
  migrateFromLegacy,
  getLegacyFingerprint,
  type MigrationOptions,
  type MigrationResult,
} from './Migration.js';
