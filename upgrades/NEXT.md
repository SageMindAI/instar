# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

`instar review --history` now shows the names of failing probes beneath each failed review entry, not just the pass/fail count. Previously, a report showing "13/16 passed" gave no indication of which probes failed, forcing agents to re-run a full review to diagnose. The CLI now reads the `results` array from each history entry (which was already returned by `/system-reviews/history`) and prints the names of probes where `passed === false` in red beneath the summary line. No server change — this is a pure display fix in `src/commands/review.ts`.

## What to Tell Your User

- **Faster health diagnosis**: "When I check my review history now, I can see exactly which probes are failing — no more re-running a full review just to find out what went wrong."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Failed probe names in review history | `instar review --history` |
