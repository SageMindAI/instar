import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SCRIPT = path.resolve(__dirname, '../../playbook-scripts/build-state.py');

function run(args: string[], cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`python3 ${SCRIPT} ${args.join(' ')}`, {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || '').trim(), exitCode: e.status || 1 };
  }
}

function runJson(args: string[], cwd: string): any {
  const { stdout } = run(args, cwd);
  try {
    return JSON.parse(stdout);
  } catch {
    return { raw: stdout };
  }
}

describe('build-state.py', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-state-'));
    fs.mkdirSync(path.join(tmpDir, '.instar', 'state', 'build'), { recursive: true });
  });

  afterEach(() => {
    // safe-git-allow: incremental-migration
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('initializes a build with default STANDARD size', () => {
      const r = runJson(['init', '"Test build"'], tmpDir);
      expect(r.status).toBe('initialized');
      expect(r.size).toBe('STANDARD');
      expect(r.protection).toBe('medium');
      expect(r.reinforcements).toBe(5);
    });

    it('initializes SMALL build with light protection', () => {
      const r = runJson(['init', '"Small task"', '--size', 'SMALL'], tmpDir);
      expect(r.protection).toBe('light');
      expect(r.reinforcements).toBe(3);
    });

    it('initializes LARGE build with heavy protection', () => {
      const r = runJson(['init', '"Big feature"', '--size', 'LARGE'], tmpDir);
      expect(r.protection).toBe('heavy');
      expect(r.reinforcements).toBe(10);
    });

    it('creates state file', () => {
      runJson(['init', '"Test"'], tmpDir);
      const stateFile = path.join(tmpDir, '.instar', 'state', 'build', 'build-state.json');
      expect(fs.existsSync(stateFile)).toBe(true);
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      expect(state.phase).toBe('idle');
      expect(state.worktree).toBeNull();
    });

    it('creates audit log', () => {
      runJson(['init', '"Test"'], tmpDir);
      const auditFile = path.join(tmpDir, '.instar', 'state', 'build', 'audit.jsonl');
      expect(fs.existsSync(auditFile)).toBe(true);
      const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n');
      expect(JSON.parse(lines[0]).event).toBe('build.initialized');
    });

    it('rejects init when active build exists', () => {
      runJson(['init', '"First"'], tmpDir);
      run(['transition', 'planning'], tmpDir);
      const { exitCode } = run(['init', '"Second"'], tmpDir);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('transitions', () => {
    beforeEach(() => {
      runJson(['init', '"Trans test"'], tmpDir);
    });

    it('follows happy path: idle -> planning -> executing -> verifying -> hardening -> complete', () => {
      expect(runJson(['transition', 'planning'], tmpDir).status).toBe('transitioned');
      expect(runJson(['transition', 'executing'], tmpDir).status).toBe('transitioned');
      expect(runJson(['transition', 'verifying'], tmpDir).status).toBe('transitioned');
      expect(runJson(['transition', 'hardening'], tmpDir).status).toBe('transitioned');
      expect(runJson(['transition', 'complete'], tmpDir).status).toBe('transitioned');
    });

    it('blocks invalid transitions', () => {
      run(['transition', 'planning'], tmpDir);
      const { exitCode } = run(['transition', 'complete'], tmpDir);
      expect(exitCode).not.toBe(0);
    });

    it('allows universal transitions (failed, escalated) from any state', () => {
      run(['transition', 'planning'], tmpDir);
      const r = runJson(['transition', 'failed'], tmpDir);
      expect(r.status).toBe('transitioned');
      expect(r.to).toBe('failed');
    });

    it('tracks fix iterations and auto-escalates', () => {
      run(['transition', 'executing'], tmpDir);
      run(['transition', 'verifying'], tmpDir);

      // 3 fix cycles allowed
      run(['transition', 'fixing'], tmpDir);
      run(['transition', 'verifying'], tmpDir);
      run(['transition', 'fixing'], tmpDir);
      run(['transition', 'verifying'], tmpDir);
      run(['transition', 'fixing'], tmpDir);
      run(['transition', 'verifying'], tmpDir);

      // 4th should escalate
      const { exitCode } = run(['transition', 'fixing'], tmpDir);
      expect(exitCode).not.toBe(0);

      // State should be escalated
      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.instar', 'state', 'build', 'build-state.json'), 'utf8')
      );
      expect(state.phase).toBe('escalated');
    });
  });

  describe('steps', () => {
    beforeEach(() => {
      runJson(['init', '"Step test"'], tmpDir);
      run(['transition', 'executing'], tmpDir);
    });

    it('records step completion', () => {
      const r = runJson(['step-complete', '1', '"Core module"', '5', '5'], tmpDir);
      expect(r.status).toBe('step_completed');
      expect(r.tests).toBe(5);
      expect(r.passing).toBe(5);
      expect(r.allPassing).toBe(true);
    });

    it('tracks total tests across steps', () => {
      runJson(['step-complete', '1', '"First"', '5', '5'], tmpDir);
      const r = runJson(['step-complete', '2', '"Second"', '10', '10'], tmpDir);
      expect(r.totalTests).toBe(15);
    });

    it('detects failing tests', () => {
      const r = runJson(['step-complete', '1', '"Failing"', '5', '3'], tmpDir);
      expect(r.allPassing).toBe(false);
    });

    it('blocks steps outside executing phase', () => {
      // Reset to planning
      const state = JSON.parse(
        fs.readFileSync(path.join(tmpDir, '.instar', 'state', 'build', 'build-state.json'), 'utf8')
      );
      state.phase = 'planning';
      fs.writeFileSync(
        path.join(tmpDir, '.instar', 'state', 'build', 'build-state.json'),
        JSON.stringify(state)
      );

      const { exitCode } = run(['step-complete', '1', '"test"', '1', '1'], tmpDir);
      expect(exitCode).not.toBe(0);
    });
  });

  describe('status', () => {
    it('reports no active build', () => {
      const r = runJson(['status'], tmpDir);
      expect(r.status).toBe('no_active_build');
    });

    it('reports active build details', () => {
      runJson(['init', '"Status test"', '--size', 'LARGE'], tmpDir);
      run(['transition', 'executing'], tmpDir);
      run(['step-complete', '1', '"First"', '10', '10'], tmpDir);

      const r = runJson(['status'], tmpDir);
      expect(r.task).toBe('Status test');
      expect(r.phase).toBe('executing');
      expect(r.size).toBe('LARGE');
      expect(r.protection).toBe('heavy');
      expect(r.stepsCompleted).toBe(1);
      expect(r.totalTests).toBe(10);
    });
  });

  describe('query', () => {
    it('queries audit log', () => {
      runJson(['init', '"Query test"'], tmpDir);
      run(['transition', 'planning'], tmpDir);
      run(['transition', 'executing'], tmpDir);
      run(['step-complete', '1', '"step"', '5', '5'], tmpDir);

      const r = runJson(['query'], tmpDir);
      expect(r.count).toBeGreaterThan(0);
    });

    it('filters by event type', () => {
      runJson(['init', '"Filter test"'], tmpDir);
      run(['transition', 'executing'], tmpDir);
      run(['step-complete', '1', '"step"', '5', '5'], tmpDir);

      const r = runJson(['query', '--event', 'step.completed'], tmpDir);
      expect(r.count).toBe(1);
      expect(r.entries[0].event).toBe('step.completed');
    });
  });

  describe('complete', () => {
    it('completes a build with passing tests', () => {
      runJson(['init', '"Complete test"'], tmpDir);
      run(['transition', 'executing'], tmpDir);
      run(['step-complete', '1', '"done"', '5', '5'], tmpDir);
      run(['transition', 'verifying'], tmpDir);
      run(['transition', 'complete'], tmpDir);

      const r = runJson(['complete'], tmpDir);
      expect(r.status).toBe('complete');
      expect(r.archivedTo).toContain('history');
    });

    it('blocks completion with failing tests', () => {
      runJson(['init', '"Fail test"'], tmpDir);
      run(['transition', 'executing'], tmpDir);
      run(['step-complete', '1', '"failing"', '5', '3'], tmpDir);

      const { exitCode } = run(['complete'], tmpDir);
      expect(exitCode).not.toBe(0);
    });

    it('archives to history directory', () => {
      runJson(['init', '"Archive test"'], tmpDir);
      run(['transition', 'executing'], tmpDir);
      run(['step-complete', '1', '"done"', '1', '1'], tmpDir);
      run(['transition', 'verifying'], tmpDir);
      run(['transition', 'complete'], tmpDir);
      runJson(['complete'], tmpDir);

      const historyDir = path.join(tmpDir, '.instar', 'state', 'build', 'history');
      expect(fs.existsSync(historyDir)).toBe(true);
      const files = fs.readdirSync(historyDir);
      expect(files.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('resume', () => {
    it('reports no build to resume', () => {
      const r = runJson(['resume'], tmpDir);
      expect(r.canResume).toBe(false);
    });

    it('resumes active build', () => {
      runJson(['init', '"Resume test"'], tmpDir);
      run(['transition', 'executing'], tmpDir);
      run(['step-complete', '1', '"partial"', '5', '5'], tmpDir);

      const r = runJson(['resume'], tmpDir);
      expect(r.canResume).toBe(true);
      expect(r.task).toBe('Resume test');
      expect(r.phase).toBe('executing');
      expect(r.stepsCompleted).toBe(1);
    });

    it('cannot resume terminal state', () => {
      runJson(['init', '"Terminal"'], tmpDir);
      run(['transition', 'failed'], tmpDir);

      const r = runJson(['resume'], tmpDir);
      expect(r.canResume).toBe(false);
    });
  });

  describe('report', () => {
    it('generates a text report', () => {
      runJson(['init', '"Report test"', '--size', 'LARGE'], tmpDir);
      run(['transition', 'executing'], tmpDir);
      run(['step-complete', '1', '"Core"', '10', '10'], tmpDir);

      const { stdout } = run(['report'], tmpDir);
      expect(stdout).toContain('Report test');
      expect(stdout).toContain('LARGE');
      expect(stdout).toContain('Core');
    });
  });
});
