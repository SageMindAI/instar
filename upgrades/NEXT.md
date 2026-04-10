# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

The memory export system (MemoryExporter) now guards against overwriting existing MEMORY.md files when SemanticMemory has 0 indexed entities. Previously, if the semantic index was empty (e.g., not yet built, or corrupted), running `instar memory export --output` or the `/semantic/export-memory` API route would replace your curated MEMORY.md with a stub containing only a header and footer — effectively wiping all your stored knowledge.

Now, if the export would produce 0 entities and the target file already exists, the write is skipped entirely. The `WriteResult` includes a `skipped: true` flag so callers can detect this case. The API route also returns a `warning` field when this happens.

This protects against the scenario where a reflection-trigger job silently resets agent memory on every run when the semantic index hasn't been populated yet.

## What to Tell Your User

- **Memory protection**: "Your memory file is now protected from being accidentally wiped. If my knowledge index is empty for any reason, I won't overwrite what I already know — I'll keep the existing memory intact."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Empty-export guard | Automatic — no action needed |
