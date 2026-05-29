import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const separatorIndex = process.argv.indexOf('--');
const command = separatorIndex === -1 ? process.argv[2] : process.argv[separatorIndex + 1];
const args = separatorIndex === -1 ? process.argv.slice(3) : process.argv.slice(separatorIndex + 2);

if (!command) {
  throw new Error('Usage: node scripts/with-frontier-sandbox-lock.mjs -- <command> [...args]');
}

const lockDir = path.join(os.tmpdir(), 'frontier-sandbox-dist.lock');
acquireLock(lockDir);
try {
  execFileSync(command, args, { stdio: 'inherit' });
} finally {
  releaseLock(lockDir);
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
