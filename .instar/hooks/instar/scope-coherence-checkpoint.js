#!/usr/bin/env node
// Scope Coherence Checkpoint — Stop hook
// The structural zoom-out. Forces agents to step back and check the big picture
// when they've been deep in implementation without reading design docs.
//
// The 232nd Lesson: Implementation depth narrows scope.
// "See code -> wire it -> declare done" vs "read spec -> understand scope -> build right thing"
//
// Calls the Instar server for active job context to make the checkpoint actionable.

// CJS imports — this is a standalone hook script, not an ESM module
const _r = require;
const fs = _r('fs');
const path = _r('path');
const http = _r('http');

const STATE_FILE = path.join('.instar', 'state', 'scope-coherence.json');
const DEPTH_THRESHOLD = 20;
const COOLDOWN_MS = 30 * 60 * 1000;  // 30 minutes — global, prevents nagging across sessions
const MIN_AGE_MS = 5 * 60 * 1000;    // 5 minutes — per-session, lets fresh sessions settle

function getSessionId() {
  return process.env.INSTAR_SESSION_ID || ('manual-' + process.pid);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return { sessions: {} };
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

function fetchActiveJob() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:4040/context/active-job', { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', async () => {
  try {
    // Never block headless/job sessions — no human to dismiss the block.
    if (process.env.INSTAR_SESSION_ID && !process.env.TERM_PROGRAM) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
      return;
    }

    const state = loadState();
    const sid = getSessionId();
    const sess = state.sessions[sid];
    const now = Date.now();
    const depth = (sess && sess.implementationDepth) || 0;

    if (depth < DEPTH_THRESHOLD) {
      process.stdout.write(JSON.stringify({ decision: 'approve' }));
      process.exit(0);
      return;
    }

    // Check cooldown (global — prevents nagging across sessions)
    if (state.lastCheckpointPrompt) {
      const elapsed = now - new Date(state.lastCheckpointPrompt).getTime();
      if (elapsed < COOLDOWN_MS) {
        process.stdout.write(JSON.stringify({ decision: 'approve' }));
        process.exit(0);
        return;
      }
    }

    // Check minimum session age (per-session)
    if (sess && sess.sessionStart) {
      const age = now - new Date(sess.sessionStart).getTime();
      if (age < MIN_AGE_MS) {
        process.stdout.write(JSON.stringify({ decision: 'approve' }));
        process.exit(0);
        return;
      }
    }

    // Fetch active job context from server
    const jobData = await fetchActiveJob();
    const dismissed = state.checkpointsDismissed || 0;
    const docsRead = (sess && sess.docsRead) || [];

    let jobContext = '';
    if (jobData && jobData.active && jobData.job) {
      jobContext = '\nYou are running the **' + jobData.job.name + '** job.\n' +
        'Scope: ' + (jobData.job.description || 'No description') + '\n' +
        'Are you still within the job\'s boundaries?\n';
    }

    let docsContext = '';
    if (docsRead.length > 0) {
      const recent = docsRead.slice(-5).map(d => d.split('/').pop());
      docsContext = '\nDocs read this session: ' + recent.join(', ');
    } else {
      docsContext = '\nNo design docs, specs, or proposals have been read this session.';
    }

    let escalation = '';
    if (dismissed >= 3) {
      escalation = '\n\nYou\'ve dismissed ' + dismissed + ' scope checkpoints. ' +
        'Dismissing scope checks during deep implementation is how scope collapse happens.';
    }

    const reason = 'SCOPE COHERENCE CHECK\n\n' +
      'You\'ve been deep in implementation for ' + depth + ' actions without reading design documents.\n' +
      'Implementation depth narrows perception.\n' +
      jobContext +
      '\nStep back and ask yourself:\n' +
      '\n1. WHO AM I? What role am I filling right now?\n' +
      '2. WHAT AM I WORKING ON? What\'s the full scope? Is there a spec or proposal?\n' +
      '3. BIG PICTURE — How does this fit into the larger system?\n' +
      '4. HIGHER-LEVEL ELEMENTS — What architectural or cross-system aspects am I missing?\n' +
      '5. COMPLETENESS — Am I considering all elements, or have I collapsed the scope?\n' +
      docsContext + escalation +
      '\n\nOptions: Read the relevant spec/proposal, confirm scope awareness,\n' +
      'invoke /grounding (if your harness ships that skill), or reset directly:\n' +
      '  curl -X POST http://localhost:4040/scope-coherence/reset';

    // Record that we prompted
    state.lastCheckpointPrompt = new Date().toISOString();
    state.checkpointsDismissed = dismissed + 1;
    saveState(state);

    process.stdout.write(JSON.stringify({ decision: 'block', reason: reason }));
  } catch {
    process.stdout.write(JSON.stringify({ decision: 'approve' }));
  }
  process.exit(0);
});
