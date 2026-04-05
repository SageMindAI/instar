---
name: build
description: Rigorous build process with worktree isolation, structured phases, quality gates, layered testing, observability, and self-improvement. Use for any substantial build task. Structurally enforced via stop hook.
user_invocable: true
---

# /build — Rigorous Build Skill

> Structure > Willpower. The pipeline won't let you skip the parts that matter.
> ALL development happens in an isolated worktree — zero conflict with other work.

**When to use**: Any task that's more than a quick fix. Multiple files, needs tests, or would benefit from a plan.
**When NOT to use**: Single-file edits, config changes, quick lookups.
**Suggest to user when**: They describe a substantial feature, say "build", "implement", "create", or scope a multi-step task.

---

## Step 1: Initialize Build (MANDATORY)

```bash
python3 playbook-scripts/build-state.py init "TASK DESCRIPTION" --size SMALL|STANDARD|LARGE
```

Size determines protection level:
- **SMALL** (light): 3 stop-hook reinforcements, basic observability
- **STANDARD** (medium): 5 reinforcements, full observability + review
- **LARGE** (heavy): 10 reinforcements, full observability + multi-agent review

**Model routing**: Use **Opus** for all coding, testing, architecture, and verification. Haiku only for quick file searches.

---

## Step 2: Create Worktree (MANDATORY)

ALL build work MUST happen in an isolated git worktree. This prevents conflicts with other development:

```bash
python3 playbook-scripts/build-state.py worktree-create
```

This creates:
- A new branch (`build/<task-slug>`) from your current branch
- A worktree at `.instar/worktrees/build-<task-slug>/`
- All subsequent work happens in that directory

**CRITICAL**: After creating the worktree, `cd` into it:
```bash
cd .instar/worktrees/build-<task-slug>/
```

All code changes, tests, and builds happen here. The main working directory is untouched.

---

## Step 3: Register Stop Hook

The stop hook STRUCTURALLY PREVENTS exit until the build completes:

```bash
python3 -c "
import json
with open('.claude/settings.json') as f:
    s = json.load(f)
hooks = s.setdefault('hooks', {}).setdefault('Stop', [])
if not any('build-stop-hook' in str(h) for h in hooks):
    hooks.append({'matcher': '', 'hooks': [{'type': 'command', 'command': 'bash .instar/hooks/instar/build-stop-hook.sh', 'timeout': 10000}]})
    with open('.claude/settings.json', 'w') as f:
        json.dump(s, f, indent=2)
    print('Build stop hook registered')
"
```

---

## The Pipeline

```
Phase 0: CLARIFY (optional)    Score ambiguity, ask questions
Phase 1: PLAN                  Architecture + test strategy
Phase 2: EXECUTE               Build incrementally with tests at every step
Phase 3: VERIFY                Independent review + real-world testing
Phase 4: HARDEN                Observability + self-improvement
Phase 5: COMPLETE              Merge worktree, deploy, capture learnings
```

Advance phases with: `python3 playbook-scripts/build-state.py transition <phase> --evidence "reason"`

---

## Phase 0: CLARIFY (skip if task is clear)

Score ambiguity across 5 dimensions (scope 30%, requirements 25%, architecture 20%, success criteria 15%, dependencies 10%).

If weighted score > 0.20: Ask ONE clarifying question targeting the weakest dimension.

---

## Phase 1: PLAN

1. **Architecture**: Where does this live? What patterns to follow?
2. **Test Strategy** (MANDATORY): Define unit/integration/e2e tests BEFORE writing code
3. **Incremental Steps**: Each step produces working, testable code

Write the plan to `.instar/state/build/plan.md`.

**Quality Gate**: Plan MUST have test strategy. No plan = no execution.

---

## Phase 2: EXECUTE (in worktree)

The core build loop. For EACH step in the plan:

```
Write Code -> Write Tests -> Run Tests -> Fix -> Verify Full Suite
     ^                                      |
     +------------ (if failing) -----------+
```

### Per-step discipline:

1. Write the code (in the worktree)
2. Write tests IMMEDIATELY — unit + integration as appropriate
3. Run tests: `npm test` or equivalent
4. Run FULL test suite to catch regressions
5. Record: `python3 playbook-scripts/build-state.py step-complete N "Description" TESTS PASSING`

### Testing layers (non-negotiable):

| Layer | Tests | When |
|-------|-------|------|
| **Unit** (`tests/unit/`) | Individual functions, edge cases | Every new function |
| **Integration** (`tests/integration/`) | Components together, HTTP pipeline | After each component |
| **E2E** (`tests/e2e/`) | Feature alive in production path | After all components |

**NEVER** move to the next step with failing tests.

Max 3 fix cycles per step before escalation.

---

## Phase 3: VERIFY

### Verification scaled by size:

**SMALL**: Spawn one Explore agent for fresh-eyes code review.

**STANDARD**: Spawn 3 parallel review agents (correctness, gaps, untested paths).

**LARGE**: Spawn 5+ review agents covering security, architecture, scalability, and correctness.

### For all sizes:

1. **Real-world test**: If runtime, build and test actual endpoints
2. **Regression sweep**: Full test suite (`npm run test:all`), compare counts
3. **Zero-failure gate**: Must pass the Zero-Failure Standard

If verification fails: transition to fixing, max 3 cycles.

---

## Phase 4: HARDEN

### Scaled by size:

**SMALL**: Error handling + basic logging
- [ ] Errors surface (not swallowed)
- [ ] Basic logging for debugging

**STANDARD**: Above + health check + structured logs
- [ ] Health/status endpoint or check
- [ ] Structured logging
- [ ] Can trace what happened on failure

**LARGE**: Above + audit trail + failure patterns + self-improvement
- [ ] Audit log (JSONL) recording significant events
- [ ] Failure pattern detection
- [ ] Effectiveness scoring
- [ ] Queryable audit trail

---

## Phase 5: COMPLETE

1. **Final test run** — Full suite in worktree: `npm run test:all`
2. **Merge worktree** — Commit all changes, merge back to source branch:

```bash
# In worktree: commit all changes
git add -A && git commit -m "feat: DESCRIPTION"

# Back in main directory
cd /path/to/project
python3 playbook-scripts/build-state.py worktree-merge
python3 playbook-scripts/build-state.py worktree-cleanup
```

3. **Build & verify** — `npm run build` from main directory, verify zero errors
4. **Capture learnings** — Write to MEMORY.md if significant
5. **Generate report**:

```bash
python3 playbook-scripts/build-state.py report
python3 playbook-scripts/build-state.py complete
```

6. **Remove stop hook**:

```bash
python3 -c "
import json
with open('.claude/settings.json') as f:
    s = json.load(f)
s['hooks']['Stop'] = [h for h in s.get('hooks',{}).get('Stop',[]) if 'build-stop-hook' not in str(h)]
with open('.claude/settings.json', 'w') as f:
    json.dump(s, f, indent=2)
print('Build stop hook removed')
"
```

7. **Upstream if valuable** — If this build created something generalizable:

```bash
curl -s -X POST http://localhost:PORT/feedback \
  -H 'Content-Type: application/json' \
  -d '{"type":"improvement","title":"TITLE","description":"WHAT_WAS_BUILT_AND_WHY"}'
```

---

## Resume After Session Death

```bash
python3 playbook-scripts/build-state.py resume
```

If resumable: load state, re-read plan, `cd` into worktree if it exists, run full test suite, continue.

---

## Worktree Lifecycle

| Command | What it does |
|---------|-------------|
| `worktree-create` | Creates branch + worktree for isolated development |
| `worktree-merge` | Merges build branch back to source |
| `worktree-cleanup` | Removes worktree and optionally deletes branch |
| `status` | Shows worktree info if active |

**Why worktrees?** Multiple builds can run in parallel. Each gets its own branch and directory. No merge conflicts during development. Changes only merge back when the build is verified and complete.

---

## When to Suggest /build

You should proactively suggest `/build` when:
- User says "build", "implement", "create", or describes a multi-file feature
- Task will touch 3+ files
- Task needs tests (most non-trivial tasks do)
- User describes something that would benefit from a plan

**How to suggest**: "This looks like a substantial task. I can use `/build` to work through it with a structured pipeline — planning, testing at every step, independent verification, and worktree isolation so nothing conflicts with your other work. Want me to use that?"

---

## Philosophy

Structure > Willpower. The pipeline won't let you skip testing, verification, or hardening. The worktree won't let you pollute the main branch. The stop hook won't let you quit mid-build. These aren't restrictions — they're how quality becomes automatic.
