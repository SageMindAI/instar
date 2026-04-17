# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

<!-- Describe what changed technically. What new features, APIs, behavioral changes? -->
<!-- Write this for the AGENT — they need to understand the system deeply. -->

## What to Tell Your User

<!-- Write talking points the agent should relay to their user. -->
<!-- This should be warm, conversational, user-facing — not a changelog. -->
<!-- Focus on what THEY can now do, not internal plumbing. -->
<!--                                                                    -->
<!-- PROHIBITED in this section (will fail validation):                 -->
<!--   camelCase config keys: silentReject, maxRetries, telegramNotify -->
<!--   Inline code backtick references like silentReject: false        -->
<!--   Fenced code blocks                                              -->
<!--   Instructions to edit files or run commands                      -->
<!--                                                                    -->
<!-- CORRECT style: "I can turn that on for you" not "set X to false"  -->
<!-- The agent relays this to their user — keep it human.              -->

- **[Feature name]**: "[Brief, friendly description of what this means for the user]"

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| [Capability] | [Endpoint, command, or "automatic"] |

## Evidence

<!-- REQUIRED if this release claims to fix a bug. -->
<!-- Unit tests passing is NOT evidence. Provide ONE of: -->
<!--   (a) Reproduction steps + observed before/after on a live system. -->
<!--       Include log excerpts, observed command output, or behavior -->
<!--       description. Make it specific enough that a future reader can -->
<!--       re-run it and see the same thing. -->
<!--   (b) "Not reproducible in dev — [concrete reason]" if the failure -->
<!--       mode truly can't be exercised locally (race conditions, -->
<!--       event-driven paths requiring external signals, etc). -->
<!--                                                                 -->
<!-- If this release doesn't claim a bug fix (pure feature / refactor), -->
<!-- leave this section blank or delete it — it's only enforced when -->
<!-- "What Changed" describes a fix. -->

[Describe reproduction + verified fix, OR "Not reproducible in dev — [concrete reason]"]
