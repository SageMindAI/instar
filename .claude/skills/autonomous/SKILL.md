---
name: autonomous
description: Enter autonomous development mode with STRUCTURAL enforcement. Uses a stop hook to prevent premature exit. Generates stop conditions and confirms with user before starting. Work independently for a specified duration with progress reporting.
user_invocable: true
---

# Autonomous Mode (Structurally Enforced)

You are entering **autonomous development mode**. This mode uses a **stop hook** that PREVENTS you from exiting until all tasks are genuinely complete. This is not optional — the hook structurally enforces continuous work.

---

## Step 1: Generate Stop Conditions (MANDATORY)

Before activating the stop hook, you MUST:

1. **Analyze the goal** and break it into specific, verifiable tasks
2. **Present the task list** to the user with clear completion criteria
3. **Wait for user confirmation** before activating the hook
4. **Define the completion promise** — a phrase that is only TRUE when ALL tasks are done

**Example interaction:**

```
User: /autonomous --duration=8h --goal="Complete Slack feature parity"

Agent: Here's my task breakdown for autonomous mode:

TASKS (all must be complete before I can exit):
1. [ ] Implement job-specific Slack channels
2. [ ] Build full PresenceProxy Slack integration
3. [ ] Update dashboard HTML with platform badges
4. [ ] Implement Slack Lifeline process
5. [ ] Add platform dropdown to new session UI
...

Completion promise: "ALL_TASKS_COMPLETE"
Duration: 8 hours
Emergency stop: "stop everything" via messaging

Shall I proceed? (The stop hook will prevent me from exiting until all tasks are done)
```

**The user must confirm before the hook activates.** This is the safety gate.

---

## Step 2: Activate the Stop Hook

After user confirmation:

**2a. Add the stop hook to settings.json** (dynamically — it's removed when the session ends):

```bash
python3 -c "
import json
with open('.claude/settings.json') as f:
    s = json.load(f)
hooks = s.setdefault('hooks', {}).setdefault('Stop', [])
if not any('autonomous-stop-hook' in str(h) for h in hooks):
    hooks.append({'matcher': '', 'hooks': [{'type': 'command', 'command': 'bash .instar/hooks/instar/autonomous-stop-hook.sh', 'timeout': 10000}]})
    with open('.claude/settings.json', 'w') as f:
        json.dump(s, f, indent=2)
    print('Stop hook registered')
"
```

**2b. Write the state file DIRECTLY** (do NOT shell out to bash — the session ID env var is only available inside Claude Code):

Use the **Write tool** to create `.instar/autonomous-state.local.md` with this content:

```markdown
---
active: true
iteration: 1
session_id: {VALUE OF $CLAUDE_CODE_SESSION_ID — get via: echo $CLAUDE_CODE_SESSION_ID}
goal: "YOUR GOAL"
duration: "8h"
duration_seconds: 28800
started_at: "{ISO timestamp}"
end_at: "{ISO timestamp + duration}"
report_topic: "TOPIC_ID"
report_interval: "30m"
last_report_at: ""
level_up: true
completion_promise: "ALL_TASKS_COMPLETE"
---

# Autonomous Session

## Goal
{goal text}

## Tasks
{numbered task list}

## Instructions
{autonomous instructions}
```

**CRITICAL**: To capture the session ID correctly, run this FIRST:
```bash
echo $CLAUDE_CODE_SESSION_ID
```
Then include the output in the `session_id:` field. This ensures session isolation works.

**WHY NOT bash script?** Running `bash setup-autonomous.sh` creates a subprocess that does NOT inherit `CLAUDE_CODE_SESSION_ID`. The state file ends up with an empty session_id, which causes the hook to leak into all sessions. Always write the state file from within Claude Code's context.

**SESSION ISOLATION**: The stop hook checks `session_id` — it only blocks the session that activated autonomous mode. Other sessions on the same machine pass through unaffected.

**From this point, you CANNOT exit THIS session** unless:
- You output `<promise>ALL_TASKS_COMPLETE</promise>` (genuinely true)
- Duration expires
- Emergency stop is triggered

**2c. On completion/exit**: Remove the stop hook from settings.json:

```bash
python3 -c "
import json
with open('.claude/settings.json') as f:
    s = json.load(f)
s['hooks']['Stop'] = [h for h in s.get('hooks',{}).get('Stop',[]) if 'autonomous-stop-hook' not in str(h)]
with open('.claude/settings.json', 'w') as f:
    json.dump(s, f, indent=2)
print('Stop hook removed')
"
```

---

## Step 3: Work Until Done

The stop hook will catch every attempt to exit and feed your task list back. Each iteration you will:

1. Read the task list
2. Pick the next incomplete task
3. Implement it fully (not stub, not wire — IMPLEMENT)
4. Verify it works (compile, test where practical)
5. Move to next task
6. Send progress reports at the configured interval

### The Defer-to-Future-Self Trap

**This is the #1 failure mode.** It looks like:

| What you think | What's actually happening |
|----------------|--------------------------|
| "This is Phase 2 work" | You don't feel like doing it right now |
| "Parked for follow-up" | You're avoiding the hard part |
| "Future improvement" | Your future self has no advantage over you |
| "Remaining work" | Work you're choosing not to do |
| "Deferred" | Abdication disguised as planning |

**The test:** Can you do this task right now with the tools and knowledge you have?
- **Yes** → Do it. Not later. Now.
- **No** → Document exactly WHY (missing dependency, needs external access, etc.)

**"Phase 2" is only valid when the current phase genuinely cannot contain the work** — not when you're tired, not when it's complex, not when it's 2 AM.

---

## Step 4: Completion

When ALL tasks are genuinely done:

1. Verify every task is complete (re-read the list)
2. Run `npx tsc --noEmit` — zero errors
3. Run relevant tests
4. Write learnings to MEMORY.md
5. Send final report via messaging
6. Output: `<promise>ALL_TASKS_COMPLETE</promise>`

The stop hook will detect the promise and allow exit.

---

## Emergency Stop

The user can always stop autonomous mode:

1. **Via messaging**: Send "stop everything" or "emergency stop" — the MessageSentinel intercepts
2. **Via file**: `touch .instar/autonomous-emergency-stop` — the stop hook checks for this
3. **Via cancel**: `/cancel-autonomous` — removes the state file

The stop hook checks for emergency stop on EVERY iteration. User safety is never compromised.

### /cancel-autonomous

To manually cancel:
```bash
rm -f .instar/autonomous-state.local.md
```

---

## Progress Reporting

Send reports to the user's messaging platform at the configured interval.

**How to send:**
```bash
cat <<'EOF' | .claude/scripts/telegram-reply.sh TOPIC_ID
AUTONOMOUS PROGRESS (iteration N, Xh elapsed / Yh total)

Completed:
- [task 1] ✅
- [task 2] ✅

Working on:
- [current task]

Remaining:
- [task 3]
- [task 4]

Issues: none
EOF
```

---

## Anti-Patterns (Structurally Enforced)

These aren't just warnings — the stop hook WILL catch you if you try to exit without completing them:

### The "Beautiful Summary" Exit
Writing a comprehensive report of what you did and what's "remaining" then trying to exit. **The hook will block you and feed the remaining tasks back.**

### The "Phase 2" Labeling
Calling incomplete work "Phase 2" and trying to exit. **The hook doesn't care about phases — it cares about the task list.**

### The "Good Stopping Point" Exit
Finding a natural break and trying to exit early. **The hook checks the task list, not your feelings about stopping.**

### The "It's 2 AM" Exit
Feeling tired (as an AI) and deferring. **You don't get tired. The hook knows this.**

---

## Hook Configuration

The stop hook is at `.claude/skills/autonomous/hooks/autonomous-stop-hook.sh`.

It reads state from `.instar/autonomous-state.local.md` and:
- Blocks exit if tasks are incomplete
- Feeds the task list + goal back as the next prompt
- Increments the iteration counter
- Checks for emergency stop signals
- Checks for duration expiry
- Checks for completion promise in `<promise>` tags
- Includes time remaining in the system message

**This is structural enforcement, not willpower.** You cannot talk your way out of the loop.
