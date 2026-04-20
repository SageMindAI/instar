#!/usr/bin/env python3
"""
Build State Manager for Instar /build skill.

Manages phase transitions, step tracking, worktree lifecycle, audit logging,
and state persistence for the rigorous build pipeline.

State lives in .instar/state/build/ following Instar's state directory convention.
Worktree support ensures all /build development happens in isolation.

Commands:
  init <task> [--size SMALL|STANDARD|LARGE]   Initialize a new build
  transition <phase> [--evidence TEXT]          Transition to a new phase
  step-complete <n> <desc> <tests> <passing>   Record a completed step
  status                                       Show current build status
  query [--event X] [--phase Y] [--limit N]    Query audit log
  report                                       Generate build summary
  complete                                     Mark build as complete
  resume                                       Check if resumable
  worktree-create [--branch NAME]              Create isolated worktree
  worktree-merge                               Merge worktree back to source
  worktree-cleanup                             Remove worktree
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STATE_DIR = Path(".instar/state/build")
STATE_FILE = STATE_DIR / "build-state.json"
AUDIT_LOG = STATE_DIR / "audit.jsonl"
PLAN_FILE = STATE_DIR / "plan.md"
HISTORY_DIR = STATE_DIR / "history"

PHASES = [
    "idle", "clarify", "planning", "executing",
    "verifying", "fixing", "hardening",
    "complete", "failed", "escalated",
]

TRANSITIONS = {
    "idle":       ["clarify", "planning", "executing"],
    "clarify":    ["planning"],
    "planning":   ["executing"],
    "executing":  ["verifying", "complete"],
    "verifying":  ["complete", "fixing", "hardening"],
    "fixing":     ["verifying", "failed", "escalated"],
    "hardening":  ["complete"],
    "complete":   [],
    "failed":     [],
    "escalated":  [],
}

UNIVERSAL_TARGETS = {"failed", "escalated"}

PROTECTION_LEVELS = {
    "SMALL":    {"reinforcements": 3, "label": "light"},
    "STANDARD": {"reinforcements": 5, "label": "medium"},
    "LARGE":    {"reinforcements": 10, "label": "heavy"},
}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def load_state():
    if not STATE_FILE.exists():
        return None
    try:
        return json.loads(STATE_FILE.read_text())
    except (json.JSONDecodeError, IOError):
        return None


def save_state(state):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2))


def append_audit(event, data=None):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"event": event, "timestamp": now_iso()}
    if data:
        entry.update(data)
    with open(AUDIT_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def read_audit():
    if not AUDIT_LOG.exists():
        return []
    entries = []
    for line in AUDIT_LOG.read_text().splitlines():
        if line.strip():
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return entries


def out(obj):
    print(json.dumps(obj))


# ─── Heartbeat (BUILD-STALL-VISIBILITY-SPEC Fix 2) ────────────

_RUNID_SAFE_RE = re.compile(r"[^a-zA-Z0-9_]")


def _read_instar_config():
    """Best-effort read of .instar/config.json. Returns (port, auth_token)."""
    try:
        cfg_path = Path(".instar/config.json")
        if not cfg_path.exists():
            return 4042, None
        cfg = json.loads(cfg_path.read_text())
        port = int(cfg.get("port", 4042) or 4042)
        token = cfg.get("authToken") or None
        return port, token
    except Exception:
        return 4042, None


def _heartbeat_run_id(state):
    """Derive a stable runId from state['startedAt'] — first 16 chars of sha256."""
    started = state.get("startedAt") or ""
    digest = hashlib.sha256(started.encode("utf-8")).hexdigest()
    safe = _RUNID_SAFE_RE.sub("_", digest)
    return safe[:16] or "build_unknown"


def post_heartbeat(state, phase, tool="none", status="phase-boundary",
                   elapsed_ms=0):
    """
    POST a /build heartbeat to the local instar server. Best-effort:
    swallows all exceptions, never blocks the calling transition.

    Routing target is read from environment:
      - INSTAR_TELEGRAM_TOPIC (int) → topicId
      - INSTAR_SLACK_CHANNEL  (str) → channelId
    If neither is set, no-op.
    """
    topic_env = os.environ.get("INSTAR_TELEGRAM_TOPIC")
    channel_env = os.environ.get("INSTAR_SLACK_CHANNEL")
    if not topic_env and not channel_env:
        return

    port, auth_token = _read_instar_config()
    run_id = _heartbeat_run_id(state)

    body = {
        "runId": run_id,
        "phase": phase,
        "tool": tool,
        "status": status,
        "elapsedMs": int(max(0, elapsed_ms)),
    }
    if topic_env:
        try:
            body["topicId"] = int(topic_env)
        except (ValueError, TypeError):
            return
    elif channel_env:
        body["channelId"] = str(channel_env)

    url = "http://127.0.0.1:%d/build/heartbeat" % port
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    if auth_token:
        req.add_header("Authorization", "Bearer %s" % auth_token)

    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError,
            socket.timeout, ConnectionError, OSError, ValueError) as exc:
        try:
            append_audit("heartbeat.skipped", {
                "phase": phase, "error": str(exc)[:200]})
        except Exception:
            pass
    except Exception as exc:  # pragma: no cover — defensive
        try:
            append_audit("heartbeat.skipped", {
                "phase": phase, "error": "unexpected: %s" % str(exc)[:200]})
        except Exception:
            pass


def git_run(args, cwd=None):
    """Run a git command and return (success, stdout, stderr)."""
    result = subprocess.run(
        ["git"] + args, capture_output=True, text=True, cwd=cwd)
    return result.returncode == 0, result.stdout.strip(), result.stderr.strip()


# ─── Worktree Commands ──────────────────────────────────────────

def cmd_worktree_create(args):
    """Create an isolated git worktree for the build."""
    state = load_state()
    if not state:
        out({"error": "No active build. Run 'init' first."})
        sys.exit(1)

    if state.get("worktree"):
        out({"error": "Worktree already exists",
             "path": state["worktree"]["path"],
             "branch": state["worktree"]["branch"]})
        sys.exit(1)

    # Determine branch name
    task_slug = state["task"][:40].lower()
    task_slug = "".join(c if c.isalnum() or c == "-" else "-" for c in task_slug)
    task_slug = task_slug.strip("-")
    branch = args.branch or ("build/%s" % task_slug)

    # Get current branch
    ok, current_branch, _ = git_run(["rev-parse", "--abbrev-ref", "HEAD"])
    if not ok:
        out({"error": "Not in a git repo"})
        sys.exit(1)

    # Create worktree path
    worktree_path = ".instar/worktrees/%s" % branch.replace("/", "-")

    # Create the worktree with a new branch
    ok, stdout, stderr = git_run(
        ["worktree", "add", "-b", branch, worktree_path, current_branch])
    if not ok:
        # Branch might exist already, try without -b
        ok, stdout, stderr = git_run(
            ["worktree", "add", worktree_path, branch])
        if not ok:
            out({"error": "Failed to create worktree",
                 "stderr": stderr})
            sys.exit(1)

    state["worktree"] = {
        "path": worktree_path,
        "branch": branch,
        "sourceBranch": current_branch,
        "createdAt": now_iso(),
    }
    save_state(state)
    append_audit("worktree.created", {
        "path": worktree_path, "branch": branch,
        "sourceBranch": current_branch})

    out({"status": "worktree_created",
         "path": worktree_path, "branch": branch,
         "sourceBranch": current_branch,
         "instruction": "cd %s to work in isolation" % worktree_path})


def cmd_worktree_merge(args):
    """Merge worktree branch back to source."""
    state = load_state()
    if not state or not state.get("worktree"):
        out({"error": "No active worktree"})
        sys.exit(1)

    wt = state["worktree"]
    source = wt["sourceBranch"]
    branch = wt["branch"]

    # Merge the build branch into source
    ok, stdout, stderr = git_run(["merge", branch, "--no-ff",
                                   "-m", "Merge build/%s" % branch])
    if not ok:
        out({"error": "Merge conflict",
             "stderr": stderr,
             "action": "Resolve conflicts manually, then run worktree-cleanup"})
        sys.exit(1)

    append_audit("worktree.merged", {
        "branch": branch, "into": source})

    out({"status": "merged", "branch": branch, "into": source})


def cmd_worktree_cleanup(args):
    """Remove the worktree."""
    state = load_state()
    if not state or not state.get("worktree"):
        out({"error": "No active worktree"})
        sys.exit(1)

    wt = state["worktree"]
    worktree_path = wt["path"]
    branch = wt["branch"]

    # Remove worktree
    git_run(["worktree", "remove", worktree_path, "--force"])

    # Optionally delete the branch
    git_run(["branch", "-d", branch])

    state["worktree"] = None
    save_state(state)
    append_audit("worktree.cleaned", {"path": worktree_path, "branch": branch})

    out({"status": "cleaned", "path": worktree_path, "branch": branch})


# ─── Core Commands ───────────────────────────────────────────────

def cmd_init(args):
    existing = load_state()
    if existing and existing.get("phase") not in ("complete", "failed", "escalated"):
        out({"error": "Active build exists", "phase": existing["phase"],
             "task": existing["task"], "hint": "Use 'complete' or 'resume' first"})
        sys.exit(1)

    size = (args.size or "STANDARD").upper()
    if size not in PROTECTION_LEVELS:
        out({"error": "Invalid size. Use SMALL, STANDARD, or LARGE"})
        sys.exit(1)

    state = {
        "task": args.task, "phase": "idle", "size": size,
        "protection": PROTECTION_LEVELS[size],
        "startedAt": now_iso(), "completedAt": None,
        "currentStep": 0, "totalSteps": 0, "steps": [],
        "totalTests": 0, "allPassing": True,
        "fixIterations": 0, "maxFixIterations": 3,
        "verifyIterations": 0, "maxVerifyIterations": 3,
        "reinforcementsUsed": 0,
        "worktree": None,
    }
    save_state(state)
    append_audit("build.initialized", {"task": args.task, "size": size})
    out({"status": "initialized", "task": args.task, "size": size,
         "protection": PROTECTION_LEVELS[size]["label"],
         "reinforcements": PROTECTION_LEVELS[size]["reinforcements"]})


def cmd_transition(args):
    state = load_state()
    if not state:
        out({"error": "No active build. Run 'init' first."})
        sys.exit(1)

    current = state["phase"]
    target = args.phase

    if target not in PHASES:
        out({"error": "Invalid phase: %s" % target, "valid": PHASES})
        sys.exit(1)

    legal = TRANSITIONS.get(current, [])
    if target not in legal and target not in UNIVERSAL_TARGETS:
        out({"error": "Cannot transition %s -> %s" % (current, target),
             "legal_targets": list(set(legal) | UNIVERSAL_TARGETS)})
        sys.exit(1)

    if target == "fixing":
        state["fixIterations"] = state.get("fixIterations", 0) + 1
        if state["fixIterations"] > state.get("maxFixIterations", 3):
            state["phase"] = "escalated"
            save_state(state)
            append_audit("build.escalated", {
                "reason": "max_fix_iterations",
                "iterations": state["fixIterations"]})
            out({"error": "Max fix iterations exceeded", "action": "escalated"})
            sys.exit(1)

    if current == "fixing" and target == "verifying":
        state["verifyIterations"] = state.get("verifyIterations", 0) + 1

    old = state["phase"]
    state["phase"] = target
    save_state(state)
    append_audit("phase.transition", {
        "from": old, "to": target,
        "evidence": args.evidence or None})
    # BUILD-STALL-VISIBILITY-SPEC Fix 2 — emit phase-boundary heartbeat.
    # Best-effort, never blocks the transition.
    try:
        post_heartbeat(state, target, status="phase-boundary")
    except Exception:
        pass
    out({"status": "transitioned", "from": old, "to": target})


def cmd_step_complete(args):
    state = load_state()
    if not state:
        out({"error": "No active build."})
        sys.exit(1)
    if state["phase"] != "executing":
        out({"error": "Not in executing phase (currently: %s)" % state["phase"]})
        sys.exit(1)

    step = {
        "step": args.step_number, "description": args.description,
        "tests": args.tests, "passing": args.passing,
        "timestamp": now_iso(),
    }
    state["steps"].append(step)
    state["currentStep"] = args.step_number
    state["totalTests"] = sum(s["tests"] for s in state["steps"])
    state["allPassing"] = all(s["tests"] == s["passing"] for s in state["steps"])
    save_state(state)
    append_audit("step.completed", {
        "step": args.step_number, "description": args.description,
        "tests": args.tests, "passing": args.passing,
        "totalTests": state["totalTests"]})
    out({"status": "step_completed", "step": args.step_number,
         "tests": args.tests, "passing": args.passing,
         "totalTests": state["totalTests"], "allPassing": state["allPassing"]})


def cmd_status(_args):
    state = load_state()
    if not state:
        out({"status": "no_active_build"})
        return

    elapsed = None
    if state.get("startedAt"):
        try:
            started = datetime.fromisoformat(
                state["startedAt"].replace("Z", "+00:00"))
            elapsed = (datetime.now(timezone.utc) - started).total_seconds() / 60
        except ValueError:
            pass

    result = {
        "task": state["task"], "phase": state["phase"],
        "size": state["size"],
        "protection": state.get("protection", {}).get("label", "unknown"),
        "currentStep": state["currentStep"],
        "stepsCompleted": len(state["steps"]),
        "totalTests": state["totalTests"],
        "allPassing": state["allPassing"],
        "fixIterations": state.get("fixIterations", 0),
        "verifyIterations": state.get("verifyIterations", 0),
        "reinforcementsUsed": state.get("reinforcementsUsed", 0),
        "elapsedMinutes": round(elapsed, 1) if elapsed else None,
    }
    if state.get("worktree"):
        result["worktree"] = state["worktree"]
    out(result)


def cmd_query(args):
    entries = read_audit()
    if args.event:
        entries = [e for e in entries if e.get("event") == args.event]
    if args.phase:
        entries = [e for e in entries
                   if e.get("to") == args.phase or e.get("from") == args.phase]
    limit = args.limit or 50
    out({"count": len(entries[-limit:]), "entries": entries[-limit:]})


def cmd_report(_args):
    state = load_state()
    if not state:
        print("No active build.")
        return

    entries = read_audit()
    elapsed_str = "unknown"
    if state.get("startedAt"):
        try:
            started = datetime.fromisoformat(
                state["startedAt"].replace("Z", "+00:00"))
            end = datetime.now(timezone.utc)
            if state.get("completedAt"):
                end = datetime.fromisoformat(
                    state["completedAt"].replace("Z", "+00:00"))
            elapsed_str = "%d min" % ((end - started).total_seconds() / 60)
        except ValueError:
            pass

    event_counts = {}
    for e in entries:
        k = e.get("event", "unknown")
        event_counts[k] = event_counts.get(k, 0) + 1

    lines = [
        "BUILD REPORT: %s" % state["task"], "",
        "Status: %s" % state["phase"],
        "Size: %s (%s protection)" % (
            state["size"], state.get("protection", {}).get("label", "?")),
        "Duration: %s" % elapsed_str,
        "Steps: %d" % len(state["steps"]),
        "Tests: %d (all passing: %s)" % (state["totalTests"], state["allPassing"]),
        "Fix cycles: %d/%d" % (
            state.get("fixIterations", 0), state.get("maxFixIterations", 3)),
    ]
    if state.get("worktree"):
        lines.append("Worktree: %s (branch: %s)" % (
            state["worktree"]["path"], state["worktree"]["branch"]))
    lines.append("")
    for s in state["steps"]:
        tag = "PASS" if s["tests"] == s["passing"] else "FAIL"
        lines.append("  Step %d: %s [%d tests, %s]" % (
            s["step"], s["description"], s["tests"], tag))
    if event_counts:
        lines.append("")
        lines.append("Audit events:")
        for k, v in sorted(event_counts.items()):
            lines.append("  %s: %d" % (k, v))
    print("\n".join(lines))


def cmd_complete(_args):
    state = load_state()
    if not state:
        out({"error": "No active build."})
        sys.exit(1)
    if not state["allPassing"]:
        out({"error": "Cannot complete: not all tests passing"})
        sys.exit(1)

    state["phase"] = "complete"
    state["completedAt"] = now_iso()
    save_state(state)
    append_audit("build.complete", {
        "task": state["task"], "totalTests": state["totalTests"],
        "stepsCompleted": len(state["steps"]),
        "fixIterations": state.get("fixIterations", 0)})

    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    hist = HISTORY_DIR / ("build-%s.json" % ts)
    hist.write_text(json.dumps(state, indent=2))

    # BUILD-STALL-VISIBILITY-SPEC Fix 2 — terminal heartbeat.
    try:
        post_heartbeat(state, "complete", status="phase-boundary")
    except Exception:
        pass
    out({"status": "complete", "task": state["task"],
         "totalTests": state["totalTests"],
         "stepsCompleted": len(state["steps"]),
         "archivedTo": str(hist)})


def cmd_resume(_args):
    state = load_state()
    if not state:
        out({"canResume": False, "reason": "No active build found"})
        return
    if state["phase"] in ("complete", "failed", "escalated"):
        out({"canResume": False,
             "reason": "Terminal state: %s" % state["phase"]})
        return
    result = {
        "canResume": True, "task": state["task"],
        "phase": state["phase"], "size": state["size"],
        "currentStep": state["currentStep"],
        "stepsCompleted": len(state["steps"]),
        "totalTests": state["totalTests"],
        "allPassing": state["allPassing"],
        "planExists": PLAN_FILE.exists(),
    }
    if state.get("worktree"):
        result["worktree"] = state["worktree"]
    out(result)


def main():
    p = argparse.ArgumentParser(description="Instar Build State Manager")
    sub = p.add_subparsers(dest="command")

    s = sub.add_parser("init")
    s.add_argument("task")
    s.add_argument("--size", choices=["SMALL", "STANDARD", "LARGE"],
                   default="STANDARD")

    s = sub.add_parser("transition")
    s.add_argument("phase")
    s.add_argument("--evidence")

    s = sub.add_parser("step-complete")
    s.add_argument("step_number", type=int)
    s.add_argument("description")
    s.add_argument("tests", type=int)
    s.add_argument("passing", type=int)

    sub.add_parser("status")

    s = sub.add_parser("query")
    s.add_argument("--event")
    s.add_argument("--phase")
    s.add_argument("--limit", type=int, default=50)

    sub.add_parser("report")
    sub.add_parser("complete")
    sub.add_parser("resume")

    s = sub.add_parser("worktree-create")
    s.add_argument("--branch")

    sub.add_parser("worktree-merge")
    sub.add_parser("worktree-cleanup")

    args = p.parse_args()
    if not args.command:
        p.print_help()
        sys.exit(1)

    {
        "init": cmd_init, "transition": cmd_transition,
        "step-complete": cmd_step_complete, "status": cmd_status,
        "query": cmd_query, "report": cmd_report,
        "complete": cmd_complete, "resume": cmd_resume,
        "worktree-create": cmd_worktree_create,
        "worktree-merge": cmd_worktree_merge,
        "worktree-cleanup": cmd_worktree_cleanup,
    }[args.command](args)


if __name__ == "__main__":
    main()
