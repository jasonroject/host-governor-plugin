import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubAgentGovernor } from '../src/subagent-governor.js';
import { ProcessManager } from '../src/process-manager.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('SubAgentGovernor', () => {
  let governor: SubAgentGovernor;
  let tempStatePath: string;

  beforeEach(() => {
    tempStatePath = path.join(
      os.tmpdir(),
      `test-legacy-gov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`
    );
    governor = new SubAgentGovernor({ stateFilePath: tempStatePath });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempStatePath)) fs.unlinkSync(tempStatePath);
      if (fs.existsSync(`${tempStatePath}.lock`)) fs.unlinkSync(`${tempStatePath}.lock`);
    } catch {}
  });

  it('should allow up to 3 sub-agents for a model and reject the 4th when timeoutMs=0', async () => {
    const model = 'gemini-3.8-flash';

    // Acquire 1st slot
    const slot1 = await governor.acquireSlot({ modelId: model, subAgentName: 'Agent-1' });
    expect(slot1.granted).toBe(true);
    expect(slot1.activeCount).toBe(1);

    // Acquire 2nd slot
    const slot2 = await governor.acquireSlot({ modelId: model, subAgentName: 'Agent-2' });
    expect(slot2.granted).toBe(true);
    expect(slot2.activeCount).toBe(2);

    // Acquire 3rd slot
    const slot3 = await governor.acquireSlot({ modelId: model, subAgentName: 'Agent-3' });
    expect(slot3.granted).toBe(true);
    expect(slot3.activeCount).toBe(3);

    // 4th slot should be REJECTED (strict limit of 3)
    const slot4 = await governor.acquireSlot({ modelId: model, subAgentName: 'Agent-4', timeoutMs: 0 });
    expect(slot4.granted).toBe(false);
    expect(slot4.activeCount).toBe(3);
    expect(slot4.message).toContain('Concurrency limit reached');
  });

  it('should enforce limits independently per model', async () => {
    // Fill model A (3 slots)
    await governor.acquireSlot({ modelId: 'gemini-3.8-flash', subAgentName: 'A1' });
    await governor.acquireSlot({ modelId: 'gemini-3.8-flash', subAgentName: 'A2' });
    await governor.acquireSlot({ modelId: 'gemini-3.8-flash', subAgentName: 'A3' });

    // Model B should still have full capacity
    const slotB1 = await governor.acquireSlot({ modelId: 'claude-3-7-sonnet', subAgentName: 'B1' });
    expect(slotB1.granted).toBe(true);
    expect(slotB1.activeCount).toBe(1);
  });

  it('should allow a new sub-agent once a slot is released', async () => {
    const model = 'gemini-2.5-pro';

    const s1 = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-1' });
    const s2 = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-2' });
    const s3 = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-3' });

    // 4th is blocked
    const s4Blocked = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-4' });
    expect(s4Blocked.granted).toBe(false);

    // Release slot 1
    const rel = governor.releaseSlot(s1.leaseId!);
    expect(rel.released).toBe(true);

    // Now 4th can acquire
    const s4Now = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-4' });
    expect(s4Now.granted).toBe(true);
  });
});

describe('ProcessManager', () => {
  let tempPidPath: string;

  beforeEach(() => {
    tempPidPath = path.join(
      os.tmpdir(),
      `test-legacy-pm-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`
    );
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempPidPath)) fs.unlinkSync(tempPidPath);
    } catch {}
  });

  it('should spawn a background process and capture output', async () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'cmd.exe' : 'echo';
    const args = isWindows ? ['/c', 'echo Hello Host Process'] : ['Hello Host Process'];

    const proc = pm.startProcess({ command: cmd, args });
    expect(proc.processId).toBeDefined();
    expect(proc.pid).toBeGreaterThan(0);

    // Wait 500ms for exit
    await new Promise((r) => setTimeout(r, 600));

    const status = pm.getProcess(proc.processId);
    expect(status?.status).toBe('completed');
    expect(status?.exitCode).toBe(0);

    const logs = pm.getLogs(proc.processId);
    expect(logs.some((l) => l.text.includes('Hello Host Process'))).toBe(true);
  });
});
