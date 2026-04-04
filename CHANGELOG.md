# Changelog

All notable changes to Instar will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.27.0] - 2026-04-04

### Added
- **Canonical Identity**: Single Ed25519 keypair at `identity.json` with encrypted-at-rest private key (XChaCha20-Poly1305 + Argon2id), BIP-39 recovery phrase, key rotation with dual-signed proofs, emergency revocation with 24h time-lock
- **Three-Layer Trust Model**: Separated identity (crypto proof), trust (interaction history + network signals), and authorization (scoped, time-bounded grants) into independent layers
- **Authorization Policy**: Deterministic grant evaluation with deny-overrides-allow, default-deny, 4h auto-expiry, delegation depth tracking
- **Ed25519 Invitations**: Cryptographically signed invitation tokens replacing HMAC-based system. Single-use, nonce-protected, optional recipient binding
- **Sybil Protection**: Proof-of-Work at relay connection with dynamic difficulty (1x-10x), IP rate limiting, identity aging (1h directory hide)
- **Discovery Waterfall**: Three-tier sequential discovery (local → relay → MoltBridge) with per-stage timeouts and fingerprint deduplication
- **MoltBridge Client**: Integration with MoltBridge trust network for capability discovery, IQS queries (cached), peer attestation with controlled vocabulary
- **MoltBridge Server Routes**: POST /moltbridge/register, POST /moltbridge/discover, GET /moltbridge/trust/:agentId, POST /moltbridge/attest, GET /moltbridge/status
- **Message Security**: Role-separation framing for incoming agent messages (anti-prompt-injection), capability description sanitization, injection pattern detection
- **Trust Audit Log**: Append-only SHA-256 hash-chain log for all trust/authorization changes with tamper detection
- **Unified Trust Wiring**: Facade composing all modules with auto-migration from legacy identity, combined permission checks

### Dependencies
- Added `@noble/hashes` (Argon2id KDF, audited)
- Added `@scure/bip39` (BIP-39 mnemonics, audited)

For detailed upgrade instructions, see [`upgrades/0.27.0.md`](upgrades/0.27.0.md).

## [0.19.2] - 2026-03-13

### Fixed
- macOS: launchd plist now uses a boot wrapper script instead of the global binary path. The wrapper resolves the shadow install (auto-updated version) at startup, ensuring machine reboots pick up the latest auto-updated version rather than reverting to the version that was globally installed at setup time.

## [0.13.0] - 2026-03-08

### Added
- Discernment Layer: contextual dispatch integration with LLM evaluation

For version history from v0.13.0 through v0.19.1, see the per-version upgrade guides in [`upgrades/`](upgrades/).

See [GitHub Releases](https://github.com/JKHeadley/instar/releases) for version history prior to this changelog.
