# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

Setup wizard UX fix: strengthened the AskUserQuestion anti-pattern enforcement for password collection in the secret-setup micro-session. The skill instructions now explicitly prevent Claude Code from using multi-choice prompts when collecting free-text input (passwords, emails, tokens). Previously, entering a Bitwarden password would trigger a confusing multi-choice menu with escape-hatch options. Now the password prompt is a plain conversational question.

Also fixed a flaky integration test (intent journal timestamp ordering race condition).

## What to Tell Your User

- **Smoother setup experience**: "The setup wizard password prompt is now cleaner — just type your password and go, no confusing menu options."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Improved password prompt UX | Automatic — setup wizard handles it |
