#!/usr/bin/env node
// Scope Coherence Collector — PostToolUse hook
// Tracks implementation depth (Edit/Write/Bash) vs scope-checking actions (Read docs).
// The 232nd Lesson: Implementation depth narrows scope.
//
// This hook records each tool action locally. Fast path — no network call.
// State persists in .instar/state/scope-coherence.json via the server API.

// CJS imports — this is a standalone hook script, not an ESM module
const _r = require;
const fs = _r('fs');
const path = _r('path');

const STATE_FILE = path.join('.instar', 'state', 'scope-coherence.json');
const SCOPE_DOC_PATTERNS = [
  'docs/', 'specs/', 'SPEC', 'PROPOSAL', 'DESIGN', 'ARCHITECTURE',
  'README', '.instar/AGENT.md', '.instar/USER.md', '.claude/context/',
  '.claude/grounding/', 'CLAUDE.md'
];
const SCOPE_DOC_EXTENSIONS = ['.md', '.txt', '.rst'];
const QUERY_PREFIXES = [
  'git status', 'git log', 'git diff', 'ls ', 'cat ', 'grep ',
  'echo ', 'which ', 'head ', 'tail ', 'wc ', 'pwd', 'date'
];
const GROUNDING_SKILLS = ['grounding', 'dawn', 'reflect', 'introspect', 'session-bootstrap'];
const MAX_SESSION_ENTRIES = 10; // prune oldest sessions beyond this

function isScopeDoc(filePath) {
  if (!filePath) return false;
  const lower = filePath.toLowerCase();
  if (SCOPE_DOC_PATTERNS.some(p => lower.includes(p.toLowerCase()))) return true;
  const parts = filePath.split('/');
  const name = parts[parts.length - 1] || '';
  const dot = name.lastIndexOf('.');
  if (dot > 0) {
    const ext = name.slice(dot);
    const stem = name.slice(0, dot);
    if (SCOPE_DOC_EXTENSIONS.includes(ext) && stem === stem.toUpperCase() && stem.length > 3) return true;
  }
  return false;
}

function getSessionId() {
  return process.env.INSTAR_SESSION_ID || ('manual-' + process.pid);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {}
  return { sessions: {}, lastCheckpointPrompt: null, checkpointsDismissed: 0 };
}

function getSessionState(state, sid) {
  if (!state.sessions[sid]) {
    state.sessions[sid] = {
      implementationDepth: 0, sessionStart: new Date().toISOString(),
      docsRead: [], lastScopeCheck: null, lastImplementationTool: null
    };
  }
  return state.sessions[sid];
}

function pruneSessions(state) {
  const keys = Object.keys(state.sessions);
  if (keys.length <= MAX_SESSION_ENTRIES) return;
  const sorted = keys.map(k => ({ key: k, start: state.sessions[k].sessionStart || '0' }));
  sorted.sort((a, b) => b.start.localeCompare(a.start)); // newest first
  for (const entry of sorted.slice(MAX_SESSION_ENTRIES)) {
    delete state.sessions[entry.key];
  }
}

function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data);
    const toolName = input.tool_name || '';
    const toolInput = input.tool_input || {};
    const agentId = input.agent_id || null;
    const agentType = input.agent_type || null;
    const state = loadState();
    const sid = getSessionId();
    const sess = getSessionState(state, sid);
    const now = new Date().toISOString();

    // Track agent context (M4: Claude Code now enriches all hook events)
    if (agentId) {
      if (!state.agentActivity) state.agentActivity = {};
      if (!state.agentActivity[agentId]) state.agentActivity[agentId] = { type: agentType, actions: 0 };
      state.agentActivity[agentId].actions++;
    }

    if (toolName === 'Edit' || toolName === 'Write') {
      sess.implementationDepth += 1;
      sess.lastImplementationTool = toolName + ':' + now;
    } else if (toolName === 'Bash') {
      const cmd = (toolInput.command || '').trim();
      const isQuery = QUERY_PREFIXES.some(p => cmd.startsWith(p));
      if (!isQuery && cmd.length > 10) {
        sess.implementationDepth += 1;
        sess.lastImplementationTool = 'Bash:' + now;
      }
    } else if (toolName === 'Read') {
      const fp = toolInput.file_path || '';
      if (isScopeDoc(fp)) {
        sess.implementationDepth = Math.max(0, sess.implementationDepth - 10);
        sess.lastScopeCheck = now;
        if (!sess.docsRead.includes(fp)) {
          sess.docsRead.push(fp);
          if (sess.docsRead.length > 20) sess.docsRead = sess.docsRead.slice(-20);
        }
      }
    } else if (toolName === 'Skill') {
      const skill = toolInput.skill || '';
      if (GROUNDING_SKILLS.includes(skill)) {
        sess.implementationDepth = 0;
        sess.lastScopeCheck = now;
      }
    }

    pruneSessions(state);
    saveState(state);
  } catch {}
  process.stdout.write(JSON.stringify({ decision: 'approve' }));
  process.exit(0);
});
