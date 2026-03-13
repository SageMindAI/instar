# Changelog

All notable changes to Instar will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.19.2] - 2026-03-13

### Fixed
- macOS: launchd plist now uses a boot wrapper script instead of the global binary path. The wrapper resolves the shadow install (auto-updated version) at startup, ensuring machine reboots pick up the latest auto-updated version rather than reverting to the version that was globally installed at setup time.

## [0.13.0] - 2026-03-08

### Added
- Discernment Layer: contextual dispatch integration with LLM evaluation

For version history from v0.13.0 through v0.19.1, see the per-version upgrade guides in [`upgrades/`](upgrades/).

See [GitHub Releases](https://github.com/SageMindAI/instar/releases) for version history prior to this changelog.
