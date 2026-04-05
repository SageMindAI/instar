#!/bin/bash
# Build Stop Hook — Structural enforcement for the /build pipeline.
#
# Prevents premature exit during active builds. Graduated protection:
#   SMALL  (light):  3 reinforcements
#   STANDARD (medium): 5 reinforcements
#   LARGE  (heavy):  10 reinforcements
#
# Reads state from .instar/state/build/build-state.json.

STATE_FILE=".instar/state/build/build-state.json"

# No state file = no active build = allow exit
if [ ! -f "$STATE_FILE" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Read state
PHASE=$(python3 -c "import json; d=json.load(open('$STATE_FILE')); print(d.get('phase','idle'))" 2>/dev/null)

# Terminal phases — allow exit
if [ "$PHASE" = "complete" ] || [ "$PHASE" = "failed" ] || [ "$PHASE" = "escalated" ]; then
  echo '{"decision":"approve"}'
  exit 0
fi

# Check and update reinforcement counter
RESULT=$(python3 -c "
import json, sys
with open('$STATE_FILE') as f:
    state = json.load(f)

protection = state.get('protection', {})
max_r = protection.get('reinforcements', 5)
used = state.get('reinforcementsUsed', 0)

if used >= max_r:
    print(json.dumps({'decision': 'approve'}))
    sys.exit(0)

state['reinforcementsUsed'] = used + 1
with open('$STATE_FILE', 'w') as f:
    json.dump(state, f, indent=2)

phase = state.get('phase', 'idle')
task = state.get('task', 'unknown')
label = protection.get('label', '?')
steps = state.get('steps', [])
total_tests = state.get('totalTests', 0)
wt = state.get('worktree')

prompts = {
    'idle': 'Build initialized. Begin with Phase 0 (CLARIFY) or Phase 1 (PLAN).',
    'clarify': 'In CLARIFY phase. Resolve ambiguity, then transition to PLAN.',
    'planning': 'In PLAN phase. Complete plan with test strategy, then EXECUTE.',
    'executing': 'In EXECUTE phase. Complete current step: code, tests, verify.',
    'verifying': 'In VERIFY phase. Run independent verification and real-world tests.',
    'fixing': 'In FIXING phase. Address findings, return to VERIFY.',
    'hardening': 'In HARDEN phase. Complete observability checklists.',
}

hint = prompts.get(phase, 'Continue with current phase.')
steps_info = ' | %d steps, %d tests' % (len(steps), total_tests) if steps else ''
wt_info = ' | worktree: %s' % wt['path'] if wt else ''

reason = (
    '/build active. Phase: %s (%s, %d/%d reinforcements)%s%s\n\n'
    'Task: %s\n\n%s\n\n'
    'Use \`python3 playbook-scripts/build-state.py status\` to check state.\n'
    'Use \`python3 playbook-scripts/build-state.py transition <phase>\` to advance.\n\n'
    'The build pipeline is not complete. Continue working.'
) % (phase, label, state['reinforcementsUsed'], max_r, steps_info, wt_info, task, hint)

print(json.dumps({'decision': 'block', 'reason': reason}))
" 2>/dev/null)

echo "$RESULT"
exit 0
