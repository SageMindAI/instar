# Package Completeness Tests and .npmignore Cleanup

## What Changed

Added a comprehensive test suite (`tests/unit/package-completeness.test.ts`) that catches the category of bug where files needed at runtime are silently excluded from the published npm package. This is the class of issue that caused the setup-wizard skill to be missing for months.

The test suite includes 6 checks:
- **Runtime file reference scan**: Parses source code for `path.join(findInstarRoot(), ...)` patterns and verifies every referenced path exists in `npm pack` output
- **Required directories guard**: Maintains a known-good list of directories that must be in the `files` field
- **Critical file presence check**: Verifies specific files (setup-wizard skill, dashboard, package.json) are packed
- **Dead .npmignore detection**: Catches negation patterns in `.npmignore` that are overridden by the `files` whitelist
- **Upgrade guide validation**: Ensures all published guides have required sections and minimum length

Also cleaned up `.npmignore` to remove dead skill inclusion rules that gave a false impression of controlling what ships. Added a comment clarifying that `package.json` `files` is the sole authority.

## What to Tell Your User

Nothing visible has changed. This is internal test infrastructure that prevents a repeat of the setup wizard not shipping — the kind of silent degradation where you get a worse experience and nobody notices.

## Summary of New Capabilities

- **Package completeness test suite**: 6 automated tests that verify every runtime-referenced file ships in the npm package
- **`.npmignore` dead code cleanup**: Removed misleading include patterns, added comment clarifying `files` is the authority
- **Regression prevention**: The exact bug that caused setup-wizard to be missing would now fail 4 out of 6 tests with specific, actionable error messages
