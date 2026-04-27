// Global vitest setup. Runs once before any test file loads.
//
// Pre-set git identity env vars so SafeGitExecutor's identity lookup
// doesn't fall through to `git config --global user.name/email` reads via
// execFileSync. Tests that mock execFileSync would otherwise have their
// mock return values consumed by the identity lookup before the actual
// test calls, producing confusing failures like "expected git push to be
// called once, got zero" because the diff-staged check returned the empty
// string from the identity-read mock.
process.env.GIT_AUTHOR_NAME ||= 'Test';
process.env.GIT_AUTHOR_EMAIL ||= 'test@instar.local';
process.env.GIT_COMMITTER_NAME ||= 'Test';
process.env.GIT_COMMITTER_EMAIL ||= 'test@instar.local';
