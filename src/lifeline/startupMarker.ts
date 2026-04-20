/**
 * Startup liveness marker — `state/lifeline-started-at.json`.
 *
 * Every lifeline startup writes this file unconditionally, capturing
 * pid / version / timestamp. It is the signal the CLI polls to determine
 * whether a `launchctl kickstart` actually took effect.
 *
 * Distinct from `last-self-restart-at.json` which is written only by the
 * restart orchestrator on self-triggered restarts — `launchctl kickstart`
 * (an external restart) does not touch that file.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface StartupMarker {
  startedAt: string;
  pid: number;
  version: string;
}

export function markerPath(stateDir: string): string {
  return path.join(stateDir, 'lifeline-started-at.json');
}

export function writeStartupMarker(stateDir: string, version: string): StartupMarker {
  const marker: StartupMarker = {
    startedAt: new Date().toISOString(),
    pid: process.pid,
    version,
  };
  const p = markerPath(stateDir);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch (err) {
    console.error(`[Lifeline] failed to write startup marker: ${err}`);
  }
  return marker;
}

export function readStartupMarker(stateDir: string): StartupMarker | null {
  try {
    const raw = fs.readFileSync(markerPath(stateDir), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.startedAt === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.version === 'string'
    ) {
      return parsed as StartupMarker;
    }
    return null;
  } catch {
    return null;
  }
}
