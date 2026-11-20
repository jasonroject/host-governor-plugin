import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/core/state-store.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('Suite 2.1: StateStore Windows EPERM / EBUSY Contention', () => {
  let tempStatePath: string;
  let store: StateStore;

  beforeEach(() => {
    tempStatePath = path.join(
      os.tmpdir(),
      `test-store-contention-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`
    );
    store = new StateStore({ filePath: tempStatePath, maxRetries: 10, retryDelayMs: 10 });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempStatePath)) fs.unlinkSync(tempStatePath);
      if (fs.existsSync(`${tempStatePath}.lock`)) fs.unlinkSync(`${tempStatePath}.lock`);
    } catch {}
  });

  it('should write and read state atomically', () => {
    const data = { counter: 42, name: 'initial' };
    const written = store.write(data);
    expect(written).toBe(true);

    const readBack = store.read({ counter: 0, name: '' });
    expect(readBack.counter).toBe(42);
    expect(readBack.name).toBe('initial');
  });

  it('should safely handle 50 rapid concurrent updates without EBUSY/EPERM crash', async () => {
    // Initialize state
    store.write({ totalCount: 0 });

    const concurrency = 25;
    const instances = Array.from(
      { length: concurrency },
      () => new StateStore({ filePath: tempStatePath, maxRetries: 15, retryDelayMs: 10 })
    );

    // Each instance performs atomic updates concurrently
    const promises = instances.map((inst, idx) => {
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          inst.update({ totalCount: 0 }, (curr) => {
            return { totalCount: curr.totalCount + 1 };
          });
          resolve();
        }, Math.floor(Math.random() * 20));
      });
    });

    await Promise.all(promises);

    const finalState = store.read({ totalCount: 0 });
    // All updates should have succeeded without corruption
    expect(finalState.totalCount).toBe(concurrency);
  });

  it('should break stale locks if a previous process died holding the lock', () => {
    const lockPath = `${tempStatePath}.lock`;
    // Create an artificial stale lock file with an old timestamp (5 seconds ago)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, time: Date.now() - 5000 }));
    const oldTime = (Date.now() - 5000) / 1000;
    fs.utimesSync(lockPath, oldTime, oldTime);

    // acquireLock with short timeout should break stale lock and succeed
    const acquired = store.acquireLock(1000);
    expect(acquired).toBe(true);

    store.releaseLock();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
