# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

- **Built-in job gate/execute commands now self-heal on refresh.** Generalizes the v0.28.32 port-repair fix. `refreshJobs` now syncs the entire `gate` field and `execute.type`/`execute.value` fields of built-in jobs (matched by slug) to the current source-of-truth defaults from `getDefaultJobs(port)`. User-tunable fields (`enabled`, `schedule`, `priority`, `model`, `telegramNotify`, etc.) are left untouched. This closes a class of bugs where existing installs' `jobs.json` keeps old gate/execute logic after a source update, causing built-in jobs to silently skip forever. The motivating case: `degradation-digest` had an old gate that checked `.instar/state/degradation-events.json` (always empty), while the current source checks `.instar/degradations.json` (the real file) — leaving 11 unreported degradations undetected for ~2 weeks. Contract change: built-in `gate`/`execute` are implementation details that track the codebase. To customize, fork under a different slug.
- Feedback cluster: `cluster-degradation-digest-gate-checks-wrong-file-job-never-runs`.

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

- **Background health checks self-heal after upgrades:** "A few of my background checks were quietly looking at outdated places after past upgrades and never running. They'll fix themselves automatically. One that was supposed to surface system warnings to you had been dark for about two weeks — it'll start working again."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Self-healing built-in job gate/execute | Automatic on refresh — built-in jobs whose gate or execute commands drifted from source defaults are resynced |
