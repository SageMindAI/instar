# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Closes a two-stage failure mode where Telegram-bound (and Slack/iMessage-bound)
agents would silently drop a user's first message after a conversational
pause longer than 15 minutes.

**Layer A — Topic-bound sessions are no longer treated as zombies after 15
minutes of idle.** SessionManager's zombie-killer used to interpret "idle at
prompt + no active processes for 15 minutes" as zombie and kill the session
unconditionally. For Telegram/Slack/iMessage agents, "idle at prompt" is the
*healthy* waiting state — the agent is waiting for the next user message.
SessionManager now consults a topic-binding checker before killing; sessions
bound to a live messaging topic use a longer threshold (`idlePromptKillMinutesBoundToTopic`,
default 240 minutes / 4 hours). Unbound sessions still respect the 15-minute
default — this only changes behaviour for messaging-bridged agents.

**Layer B — Failed `--resume` spawns now fall through to a fresh spawn instead
of dropping the user's message.** When a stale resume UUID crashed Claude
during startup, the readiness probe would time out and the user's initial
message was logged "NOT injected" and silently dropped. SessionManager now
detects that case (tmux died during startup with `--resume`), emits a
`resumeFailed` event so the bridge can clear the bad UUID, and retries once
without `--resume` carrying the same initial message. The bridge listener
gates the UUID cleanup on equality with the failed UUID, so a fresh spawn
that quickly saved a new UUID won't have it wiped.

## What to Tell Your User

- **No more "session appears stopped" after a pause**: When you message your
  agent after stepping away for a while, you'll go straight to a live
  response instead of waiting through a 5-minute presence-proxy warning and
  having to reply "unstick" or copy-paste your message. The agent stays
  alive while it's bound to your conversation, so your next message reaches
  it directly without a respawn detour.
- **Multi-topic agents will hold more memory between conversations**: Each
  bound agent now stays resident for up to 4 hours of pure idle (was 15
  minutes). On a memory-constrained host with 8 or more active
  conversations, that can mean a few extra gigabytes of resident memory
  during long idle windows. If that's a problem on your machine, ask your
  agent to lower the bound-session idle threshold for you — it'll handle
  the change conversationally, no config editing needed.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Topic-bound sessions survive idle pauses | Automatic; bound sessions now release at 4h instead of 15m. Override via `idlePromptKillMinutesBoundToTopic` in `.instar/config.json` if you want longer/shorter. |
| Failed `--resume` falls back to fresh spawn | Automatic. Stale resume UUIDs that crash Claude during startup now trigger a single fresh-spawn retry carrying your message, rather than dropping it. |

## Evidence

- Repro traced from Inspec/monroe-workspace logs: zombie kill at
  `2026-05-04T23:39:14Z`, respawn-with-resume crash at
  `2026-05-05T00:48:16Z`, `Claude not ready ... message NOT injected` four
  seconds later. 19 prior occurrences of the same pattern in the same log
  file going back to 2026-04-28.
- 14 new unit tests across three files covering the binding-aware kill
  behaviour, the fresh-spawn fallback, and the `resumeFailed` listener's
  UUID-equality gate. Plus 81 related tests in 7 files all green.
- Side-effects review at `upgrades/side-effects/zombie-kill-topic-binding.md`
  with second-pass review concerns resolved before commit (default lowered
  from 24h to 4h, UUID-equality gate added, status-update order fixed,
  test gaps closed, name-reconstruction fragility removed).
