import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const packageDir = path.dirname(fileURLToPath(import.meta.url));
const localSandboxDir = path.resolve(packageDir, '..', 'frontier-sandbox');

ensureLocalSandboxDist();
fs.rmSync(path.join(packageDir, 'dist'), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
withFrontierSandboxDistLock(() => {
  execFileSync(resolveTsc(), ['-b', path.join(packageDir, 'tsconfig.json'), '--force'], { stdio: 'inherit' });
});

function resolveTsc() {
  const command = process.platform === 'win32' ? 'tsc.cmd' : 'tsc';
  const candidates = [
    path.join(packageDir, 'node_modules', '.bin', command),
    path.join(packageDir, '..', 'json-diff', 'node_modules', '.bin', command)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return command;
}

function ensureLocalSandboxDist() {
  if (!fs.existsSync(path.join(localSandboxDir, 'package.json'))) return;
  if (fs.existsSync(path.join(localSandboxDir, 'dist', 'index.d.ts')) && fs.existsSync(path.join(localSandboxDir, 'dist', 'index.js'))) return;
  execFileSync('npm', ['--prefix', localSandboxDir, 'run', 'build'], { stdio: 'inherit' });
}

function withFrontierSandboxDistLock(callback) {
  const lockDir = path.join(os.tmpdir(), 'frontier-sandbox-dist.lock');
  acquireLock(lockDir);
  try {
    callback();
  } finally {
    releaseLock(lockDir);
  }
}

function acquireLock(lockDir) {
  const staleMs = 120000;
  while (true) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        startedAt: Date.now(),
        cwd: process.cwd()
      }));
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
        stale = !owner.startedAt || Date.now() - owner.startedAt > staleMs;
      } catch {
        try {
          const stat = fs.statSync(lockDir);
          stale = Date.now() - stat.mtimeMs > staleMs;
        } catch {
          stale = true;
        }
      }
      if (stale) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      sleep(50);
    }
  }
}

function releaseLock(lockDir) {
  fs.rmSync(lockDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
