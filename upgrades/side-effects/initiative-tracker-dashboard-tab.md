# Side-Effects Review — Initiative Tracker dashboard tab

**Version / slug:** `initiative-tracker-dashboard-tab`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required — read-only UI surface, identical XSS-safety pattern to the PR Pipeline tab shipped in Phase A commit fb16f5c`

## Summary of the change

Adds an "Initiatives" tab to the dashboard that renders the initiatives
board at a glance: each initiative's title, status, phases (as pills),
last-touched date, blockers, and a digest summary of actionable signals
(stale / needs-user / next-check-due / ready-to-advance).

Read-only. No mutation buttons in this commit — the tracker already
exposes CRUD via the HTTP API, but the dashboard does not wire any of
those mutating endpoints to UI actions at this layer. Keeps the XSS
attack surface minimal while the tracker is new.

Files modified:
- `dashboard/index.html` — tab button, panel container, TAB_REGISTRY
  entry, `loadInitiatives()` function (~170 lines).
- **new** `tests/unit/dashboard-initiativesTab.test.ts` — 9 smoke tests
  inspecting the HTML to verify wiring, XSS invariant, and signal
  rendering.

## Decision-point inventory

1. **Read-only vs. mutable UI**: read-only. The API supports mutation
   via CRUD + phase-transition, but exposing those as buttons would
   widen the XSS surface and introduce state-mutation from the browser.
   Defer to a later commit after live-use feedback tells us what, if
   anything, deserves a UI button.
2. **Digest panel placement**: top of tab content, only visible when
   `digestRes.items.length > 0`. Zero items = quiet panel. Matches the
   "don't push noise" principle for the digest job.
3. **Status filter default**: 'active'. Most-useful-first; user can
   flip to 'All' / 'Completed' / 'Archived' / 'Abandoned' via the
   dropdown.
4. **Count badge**: tab button shows the count of initiatives matching
   the current filter (matches Sessions / Jobs tab convention).

## 1. Over-block / 2. Under-block review

N/A — tab is read-only. No gating decision in this surface.

## 3. Level-of-abstraction fit

UI rendering lives next to the PR Pipeline tab (same file, same
patterns, same XSS invariants). `loadInitiatives()` is a sibling of
`loadPrPipeline()` in layout and structure.

## 4. Signal-vs-authority review

The digest panel renders **signals** produced by the tracker; the UI
has no blocking authority over anything. A human user is a smart gate;
showing them signals is exactly the right hand-off.

## 5. Interactions review

- **No effect on PR Pipeline tab**: separate panel, separate loader,
  separate TAB_REGISTRY entry.
- **No effect on other tabs**: tab registry is additive.
- **XSS**: all content goes through `textContent` or DOM element
  construction; `innerHTML` is not used anywhere inside
  `loadInitiatives()`. Enforced by a test.

## 6. External surfaces

- Dashboard HTML served to authenticated users (dashboard PIN or auth
  token). No new public surface.
- Two new GET requests when the tab activates:
  `GET /initiatives?status=active`, `GET /initiatives/digest`. Both
  behind existing auth middleware.

## 7. Rollback cost

Very low. `git revert` removes the tab button, panel, registry entry,
and loader function — no residual state.

## Conclusion

Additive UI surface. 9 new smoke tests (all passing). `tsc --noEmit`
not affected (HTML/JS, not TS). XSS invariant guarded by a test that
greps the function body for `.innerHTML =` assignments.

Commit 2 of 4 for the Initiative Tracker feature (commit 1 = core +
API; commit 3 = daily digest job; commit 4 = seed real initiatives).

## Evidence pointers

- Smoke tests: `tests/unit/dashboard-initiativesTab.test.ts` (9 pass).
- Referenced spec: `docs/specs/INITIATIVE-TRACKER-SPEC.md`.
- Prior art: `dashboard/index.html` commit `fb16f5c` (PR Pipeline tab).
