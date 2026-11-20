import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SubAgentGovernor } from '../src/core/subagent-governor.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('Suite 2 & 4: Sub-Agent Concurrency & Scheduling', () => {
  let statePath: string;
  let governor: SubAgentGovernor;

  beforeEach(() => {
    statePath = path.join(os.tmpdir(), `test-gov-state-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`);
    governor = new SubAgentGovernor({ maxSlots: 3, stateFilePath: statePath });
  });

  afterEach(() => {
    try {
      if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
      if (fs.existsSync(`${statePath}.lock`)) fs.unlinkSync(`${statePath}.lock`);
    } catch {}
  });

  it('should enforce strict <= 3 concurrent limit per model', async () => {
    const model = 'gemini-3.8-flash';

    const r1 = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-1' });
    const r2 = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-2' });
    const r3 = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-3' });

    expect(r1.granted).toBe(true);
    expect(r2.granted).toBe(true);
    expect(r3.granted).toBe(true);

    // 4th request must be rejected when timeoutMs is 0
    const r4 = await governor.acquireSlot({ modelId: model, subAgentName: 'Worker-4', timeoutMs: 0 });
    expect(r4.granted).toBe(false);
    expect(r4.activeCount).toBe(3);
    expect(r4.message).toContain('Concurrency limit reached');
  });

  it('should prioritize high-priority requests in the queue', async () => {
    const model = 'claude-3-7-sonnet';

    // Saturate slots
    const s1 = await governor.acquireSlot({ modelId: model, subAgentName: 'S1' });
    await governor.acquireSlot({ modelId: model, subAgentName: 'S2' });
    await governor.acquireSlot({ modelId: model, subAgentName: 'S3' });

    // Enqueue a normal request and a high request
    const normalPromise = governor.acquireSlot({
      modelId: model,
      subAgentName: 'Normal-Worker',
      priority: 'normal',
      timeoutMs: 2000
    });

    const criticalPromise = governor.acquireSlot({
      modelId: model,
      subAgentName: 'Critical-Worker',
      priority: 'critical',
      timeoutMs: 2000
    });

    // Release 1 slot
    governor.releaseSlot(s1.leaseId!);

    // Critical should receive the slot first
    const criticalResult = await criticalPromise;
    expect(criticalResult.granted).toBe(true);
    expect(criticalResult.priority).toBe('critical');
  });

  it('should support idempotency keys and prevent duplicate accounting', async () => {
    const model = 'o3';
    const idemKey = 'txn-unique-12345';

    const first = await governor.acquireSlot({
      modelId: model,
      subAgentName: 'TestAgent',
      idempotencyKey: idemKey
    });

    expect(first.granted).toBe(true);
    expect(first.isIdempotentReplay).toBeFalsy();

    // Replay same request
    const replay = await governor.acquireSlot({
      modelId: model,
      subAgentName: 'TestAgent',
      idempotencyKey: idemKey
    });

    expect(replay.granted).toBe(true);
    expect(replay.leaseId).toBe(first.leaseId);
    expect(replay.isIdempotentReplay).toBe(true);
    expect(replay.activeCount).toBe(1); // Still 1, NOT 2!
  });

  it('should share state across independent governor instances via shared state file', async () => {
    const model = 'gemini-2.5-pro';

    // Instance 1
    const inst1 = new SubAgentGovernor({ maxSlots: 3, stateFilePath: statePath });
    // Instance 2
    const inst2 = new SubAgentGovernor({ maxSlots: 3, stateFilePath: statePath });

    // Inst 1 acquires 2 slots
    await inst1.acquireSlot({ modelId: model, subAgentName: 'Agent-From-Inst1-A' });
    await inst1.acquireSlot({ modelId: model, subAgentName: 'Agent-From-Inst1-B' });

    // Inst 2 acquires 1 slot (now total = 3)
    const slot3 = await inst2.acquireSlot({ modelId: model, subAgentName: 'Agent-From-Inst2' });
    expect(slot3.granted).toBe(true);
    expect(slot3.activeCount).toBe(3);

    // Inst 1 tries 4th slot: must be blocked because Inst 2 took the 3rd!
    const slot4 = await inst1.acquireSlot({ modelId: model, subAgentName: 'Agent-Overflow', timeoutMs: 0 });
    expect(slot4.granted).toBe(false);
    expect(slot4.activeCount).toBe(3);
  });
});
