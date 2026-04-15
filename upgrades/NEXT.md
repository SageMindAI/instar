# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Telegram polling diagnostics + transient 401 retry.**

Previously, `TelegramAdapter.poll()` set `this.polling = false` permanently on
ANY 401 response — including transient auth blips — with no retry and no signal
to the probe layer. Health probes reported "polling not active" with no WHY,
and operators had to dig through logs to discover whether the token was actually
revoked or had just hiccuped.

This release adds:
- **Single 30s retry on first 401** before declaring fatal. Genuine token
  revocation still stops polling; transient 401s recover automatically.
- **Diagnostic state on the adapter**: `lastError`, `consecutivePollErrors`,
  `fatalReason` (`'401' | 'network' | null`), `stoppedAt`. Exposed via
  `TelegramAdapter.getStatus()`.
- **MessagingProbe** now surfaces these fields. The `instar.messaging.connected`
  probe description includes the fatal reason or last error, and remediation
  steps for a 401 now point operators at @BotFather rather than generic advice.

Reset of all diagnostic fields happens in `start()` so re-starts begin clean.

## What to Tell Your User

- **Better visibility when Telegram messaging stops**: "If my Telegram connection ever drops, I can now tell you exactly why instead of just saying it's down."
- **Resilience to brief auth hiccups**: "A momentary blip in the Telegram service won't permanently knock me offline anymore — I'll retry once before giving up."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Telegram polling diagnostics | Automatic — visible in health probe output |
| Transient 401 retry | Automatic — single 30s retry before declaring fatal |
