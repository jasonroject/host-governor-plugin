import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHostGovernorServer } from '../src/adapters/mcp-server.js';
import { ProcessManager } from '../src/core/process-manager.js';
import { SubAgentGovernor } from '../src/core/subagent-governor.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('Suite 8 & 10: Backward Compatibility & MCP Interface', () => {
  let tempPidPath: string;
  let tempStatePath: string;

  beforeEach(() => {
    tempPidPath = path.join(
      os.tmpdir(),
      `test-compat-pm-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`
    );
    tempStatePath = path.join(
      os.tmpdir(),
      `test-compat-gov-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`
    );
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tempPidPath)) fs.unlinkSync(tempPidPath);
      if (fs.existsSync(tempStatePath)) fs.unlinkSync(tempStatePath);
      if (fs.existsSync(`${tempStatePath}.lock`)) fs.unlinkSync(`${tempStatePath}.lock`);
    } catch {}
  });

  it('should expose all 8 legacy tools plus governor_diagnose without breaking schema', () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });
    const gov = new SubAgentGovernor({ maxSlots: 3, stateFilePath: tempStatePath });
    const server = createHostGovernorServer({ processManager: pm, subAgentGovernor: gov });
    const registeredTools = (server as any)._registeredTools;

    const expectedTools = [
      'host_exec_start',
      'host_exec_status',
      'host_exec_logs',
      'host_exec_input',
      'host_exec_stop',
      'governor_acquire_slot',
      'governor_release_slot',
      'governor_status',
      'governor_diagnose'
    ];

    for (const toolName of expectedTools) {
      expect(registeredTools[toolName]).toBeDefined();
    }
  });

  it('should accept legacy parameter shapes without errors', async () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });
    const gov = new SubAgentGovernor({ maxSlots: 3, stateFilePath: tempStatePath });
    const server = createHostGovernorServer({ processManager: pm, subAgentGovernor: gov });
    const tools = (server as any)._registeredTools;

    // Test legacy governor_acquire_slot call
    const acquireHandler = tools['governor_acquire_slot'].handler;
    const acquireRes = await acquireHandler({
      modelId: 'gemini-3.8-flash',
      subAgentName: 'LegacyCaller'
    });

    expect(acquireRes.content[0].text).toContain('Slot granted');
    const parsed = JSON.parse(acquireRes.content[0].text);
    expect(parsed.granted).toBe(true);
    expect(parsed.leaseId).toBeDefined();

    // Test legacy governor_release_slot call
    const releaseHandler = tools['governor_release_slot'].handler;
    const releaseRes = await releaseHandler({ leaseId: parsed.leaseId });
    expect(JSON.parse(releaseRes.content[0].text).released).toBe(true);

    // Test legacy governor_status call
    const statusHandler = tools['governor_status'].handler;
    const statusRes = await statusHandler({});
    const statusReport = JSON.parse(statusRes.content[0].text);
    expect(statusReport.policy.maxSubAgentsPerModel).toBe(3);
  });
});
