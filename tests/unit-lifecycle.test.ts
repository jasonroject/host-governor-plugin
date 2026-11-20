import { describe, it, expect, beforeEach } from 'vitest';
import { ProcessStateMachine } from '../src/core/state-machine.js';
import { BoundedLogBuffer } from '../src/core/bounded-buffer.js';
import { SecurityGuard } from '../src/core/security-guard.js';
import { ProcessTree } from '../src/core/process-tree.js';
import { spawn } from 'node:child_process';

describe('Suite 1: Process State Machine & Lifecycle', () => {
  it('should enforce legal state transitions', () => {
    const sm = new ProcessStateMachine('created');
    expect(sm.getState()).toBe('created');

    sm.transition('running', 'Process spawned');
    expect(sm.getState()).toBe('running');

    sm.transition('completed', 'Exit code 0');
    expect(sm.getState()).toBe('completed');
    expect(sm.isTerminal()).toBe(true);
  });

  it('should throw on illegal state transitions', () => {
    const sm = new ProcessStateMachine('created');
    sm.transition('running');
    sm.transition('completed');

    // Terminal state cannot transition to running
    expect(() => sm.transition('running')).toThrow(/Illegal state transition/);
  });

  it('should record complete timestamped transition history', () => {
    const sm = new ProcessStateMachine('created', 'Init');
    sm.transition('queued', 'In queue');
    sm.transition('running', 'Starting');
    sm.transition('timed_out', 'Timeout exceeded');

    const history = sm.getHistory();
    expect(history.length).toBe(4);
    expect(history[0].to).toBe('created');
    expect(history[3].to).toBe('timed_out');
    expect(history[3].reason).toBe('Timeout exceeded');
  });
});

describe('Suite 2: Bounded Log Buffer & Secret Redaction', () => {
  it('should redact sensitive credentials and API tokens', () => {
    const raw = 'Connected with Bearer secret-token-123456789 and sk-abcdef123456789012345678';
    const redacted = SecurityGuard.redact(raw);
    expect(redacted).not.toContain('secret-token-123456789');
    expect(redacted).not.toContain('sk-abcdef');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('sk-[REDACTED]');
  });

  it('should preserve head and tail logs under high volume', () => {
    const buf = new BoundedLogBuffer({ maxLines: 50, headLines: 10, processId: 'test-1' });

    for (let i = 1; i <= 100; i++) {
      buf.append('stdout', `Log line ${i}`);
    }

    const logs = buf.getLogs();
    expect(logs.length).toBeLessThanOrEqual(50);
    // Head lines preserved
    expect(logs[0].text).toBe('Log line 1');
    expect(logs[9].text).toBe('Log line 10');
    // Tail lines preserved
    expect(logs[logs.length - 1].text).toBe('Log line 100');
  });
});

describe('Suite 5: Process Tree Termination & Cleanup', () => {
  it('should detect alive process and terminate cleanly', async () => {
    // Cross-platform long-running process using node
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
    expect(child.pid).toBeDefined();

    const pid = child.pid!;
    expect(await ProcessTree.isAlive(pid)).toBe(true);

    const termResult = await ProcessTree.terminate(pid, true);
    expect(termResult.success).toBe(true);

    // Wait 300ms and verify process is dead
    await new Promise((r) => setTimeout(r, 400));
    expect(await ProcessTree.isAlive(pid)).toBe(false);
  });
});
