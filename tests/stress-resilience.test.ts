import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProcessManager } from '../src/core/process-manager.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('Suite 3 & 9: Stress, Resilience & Concurrency', () => {
  let tempPidPath: string;

  beforeEach(() => {
    tempPidPath = path.join(
      os.tmpdir(),
      `test-stress-pm-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`
    );
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempPidPath)) fs.unlinkSync(tempPidPath);
    } catch {}
  });

  it('should run 15 concurrent host processes cleanly and collect exit codes', async () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'cmd.exe' : 'echo';

    const count = 15;
    const processRecords = [];

    for (let i = 0; i < count; i++) {
      const args = isWindows ? ['/c', `echo task-${i}`] : [`task-${i}`];
      const p = pm.startProcess({ command: cmd, args, tag: `batch-${i}` });
      processRecords.push(p);
    }

    expect(processRecords.length).toBe(count);

    // Wait 1.5s for all to complete
    await new Promise((r) => setTimeout(r, 1500));

    const all = pm.listProcesses();
    const completed = all.filter((p) => p.state === 'completed');
    expect(completed.length).toBe(count);
  });

  it('should enforce execution timeouts and transition state to timed_out', async () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });

    // Cross-platform long-running process using node, timeout set to 600ms
    const proc = pm.startProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 15000)'],
      timeoutMs: 600
    });

    expect(proc.state).toBe('running');

    // Wait 1100ms
    await new Promise((r) => setTimeout(r, 1100));

    const inspect = pm.getProcess(proc.processId);
    expect(inspect?.state).toBe('timed_out');
    expect(inspect?.stateHistory.some((h) => h.to === 'timed_out')).toBe(true);
  });

  it('should handle memory buffer limits under sustained logging without memory leak', () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'cmd.exe' : 'echo';

    const proc = pm.startProcess({
      command: cmd,
      args: isWindows ? ['/c', 'echo done'] : ['done'],
      logBufferSize: 100
    });

    const initialMemory = process.memoryUsage().heapUsed;

    // Simulate 50,000 log events delivered to buffer
    const buf = (pm as any).logBuffers.get(proc.processId);
    for (let i = 0; i < 50000; i++) {
      buf.append('stdout', `Massive log line output stream test iteration number ${i}`);
    }

    const currentLogs = pm.getLogs(proc.processId, 100);
    expect(currentLogs.length).toBeLessThanOrEqual(100);

    const finalMemory = process.memoryUsage().heapUsed;
    const diffMb = (finalMemory - initialMemory) / (1024 * 1024);
    // Heap should not have ballooned by more than 20MB
    expect(diffMb).toBeLessThan(20);
  });
});
