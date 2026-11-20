import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProcessManager } from '../src/core/process-manager.js';
import { SubAgentGovernor } from '../src/core/subagent-governor.js';
import { createHostGovernorServer } from '../src/adapters/mcp-server.js';
import { SecurityGuard } from '../src/core/security-guard.js';
import { ProcessTree } from '../src/core/process-tree.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

describe('Suite 5 & 10: Security, Observability & Disconnect Recovery', () => {
  let tempStatePath: string;
  let tempPidPath: string;
  let originalAllowedRoots: string | undefined;

  beforeEach(() => {
    tempStatePath = path.join(
      os.tmpdir(),
      `test-sec-state-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`
    );
    tempPidPath = path.join(
      os.tmpdir(),
      `test-sec-pids-${Date.now()}-${Math.random().toString(36).substring(2, 6)}.json`
    );
    originalAllowedRoots = process.env.GOVERNOR_ALLOWED_ROOTS;
  });

  afterEach(() => {
    if (originalAllowedRoots !== undefined) {
      process.env.GOVERNOR_ALLOWED_ROOTS = originalAllowedRoots;
    } else {
      delete process.env.GOVERNOR_ALLOWED_ROOTS;
    }

    try {
      if (fs.existsSync(tempStatePath)) fs.unlinkSync(tempStatePath);
      if (fs.existsSync(`${tempStatePath}.lock`)) fs.unlinkSync(`${tempStatePath}.lock`);
      if (fs.existsSync(tempPidPath)) fs.unlinkSync(tempPidPath);
    } catch {}
  });

  // 1. Command Injection & Unsafe Shell Rejection
  it('should not execute chained shell metacharacters when allowShell is false', async () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });

    // With allowShell: false (default), metacharacters like & or ; are passed as literal arguments
    const proc = pm.startProcess({
      command: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', 'safe_arg & echo hacked_command'],
      allowShell: false
    });

    await new Promise((r) => setTimeout(r, 600));

    const logs = pm.getLogs(proc.processId);
    const combined = logs.map((l) => l.text).join(' ');

    // The argument should be received literally by node, not executed as a second shell command
    expect(combined).toContain('safe_arg & echo hacked_command');
    expect(proc.state).toBe('completed');
  });

  // 2. Allowlist / Working Directory Enforcement
  it('should reject execution in directories outside GOVERNOR_ALLOWED_ROOTS with ERR_PATH_RESTRICTED', () => {
    const allowedDir = path.join(os.tmpdir(), `allowed-test-dir-${Date.now()}`);
    fs.mkdirSync(allowedDir, { recursive: true });
    process.env.GOVERNOR_ALLOWED_ROOTS = allowedDir;

    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });

    try {
      // Attempt to run in a directory outside the whitelist (e.g. process.cwd())
      const outsideDir = path.resolve('..');
      expect(() => {
        pm.startProcess({
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: outsideDir
        });
      }).toThrow(/ERR_PATH_RESTRICTED/);
    } finally {
      try {
        fs.rmdirSync(allowedDir);
      } catch {}
    }
  });

  // 3. Sensitive Env Var & Secret Redaction in Logs
  it('should redact sensitive environment variables and tokens in process logging', async () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });

    // Test secret redaction helper directly
    const redactedEnv = SecurityGuard.redactEnv({
      OPENAI_API_KEY: 'sk-abcdef123456789012345678',
      DATABASE_PASSWORD: 'supersecretpassword123',
      SAFE_VAR: 'normal_value'
    });

    expect(redactedEnv.OPENAI_API_KEY).toBe('[REDACTED]');
    expect(redactedEnv.DATABASE_PASSWORD).toBe('[REDACTED]');
    expect(redactedEnv.SAFE_VAR).toBe('normal_value');

    // Test log stream redaction for sensitive patterns emitted to stdout
    const proc = pm.startProcess({
      command: process.execPath,
      args: [
        '-e',
        'console.log("Token: Bearer my-secret-token-123456789 and API key sk-999888777666555444333222");'
      ]
    });

    await new Promise((r) => setTimeout(r, 600));

    const logs = pm.getLogs(proc.processId);
    const combined = logs.map((l) => l.text).join(' ');

    expect(combined).not.toContain('my-secret-token-123456789');
    expect(combined).not.toContain('sk-999888777666555444333222');
    expect(combined).toContain('Bearer [REDACTED]');
    expect(combined).toContain('sk-[REDACTED]');
  });

  // 4. Observability Metrics & Diagnostic Output
  it('should return complete metrics via governor_status and governor_diagnose', async () => {
    const pm = new ProcessManager({ pidRegistryPath: tempPidPath });
    const gov = new SubAgentGovernor({ maxSlots: 3, stateFilePath: tempStatePath });
    const server = createHostGovernorServer({ processManager: pm, subAgentGovernor: gov });
    const tools = (server as any)._registeredTools;

    // Acquire 2 slots for gemini-3.8-flash
    await tools['governor_acquire_slot'].handler({
      modelId: 'gemini-3.8-flash',
      subAgentName: 'Worker-A'
    });
    await tools['governor_acquire_slot'].handler({
      modelId: 'gemini-3.8-flash',
      subAgentName: 'Worker-B'
    });

    // Start a host process
    const startRes = await tools['host_exec_start'].handler({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      tag: 'test-observability-proc'
    });
    const { processId } = JSON.parse(startRes.content[0].text);

    // 1. Call governor_status
    const statusRes = await tools['governor_status'].handler({});
    const statusData = JSON.parse(statusRes.content[0].text);

    expect(statusData.policy.maxSubAgentsPerModel).toBe(3);
    expect(statusData.metrics.totalProcessesTracked).toBeGreaterThanOrEqual(1);
    expect(statusData.metrics.activeProcesses).toBeGreaterThanOrEqual(1);

    const modelMetrics = statusData.models.find((m: any) => m.modelId === 'gemini-3.8-flash');
    expect(modelMetrics).toBeDefined();
    expect(modelMetrics.activeSlots).toBe(2);
    expect(modelMetrics.availableSlots).toBe(1);

    // 2. Call governor_diagnose
    const diagRes = await tools['governor_diagnose'].handler({});
    const diagData = JSON.parse(diagRes.content[0].text);

    expect(diagData.platform).toBe(process.platform);
    expect(diagData.nodeVersion).toBe(process.version);
    expect(diagData.memoryUsage.heapUsed).toBeGreaterThan(0);
    expect(diagData.concurrencyStatus.configuredMaxPerModel).toBe(3);
    expect(diagData.concurrencyStatus.totalModelsTracked).toBeGreaterThanOrEqual(1);

    // Cleanup process
    await tools['host_exec_stop'].handler({ processId, force: true });
  });

  // 5. MCP Disconnect & Recovery Behavior
  it('should keep background processes alive across MCP session teardown and reconnect', async () => {
    const pm1 = new ProcessManager({ pidRegistryPath: tempPidPath });
    const gov1 = new SubAgentGovernor({ maxSlots: 3, stateFilePath: tempStatePath });
    const server1 = createHostGovernorServer({ processManager: pm1, subAgentGovernor: gov1 });
    const tools1 = (server1 as any)._registeredTools;

    // 1. Start background process and acquire slot in session 1
    const startRes = await tools1['host_exec_start'].handler({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'],
      tag: 'persistent-task'
    });
    const { processId, pid } = JSON.parse(startRes.content[0].text);

    const slotRes = await tools1['governor_acquire_slot'].handler({
      modelId: 'recovery-model',
      subAgentName: 'PersistentAgent'
    });
    const { leaseId } = JSON.parse(slotRes.content[0].text);

    expect(await ProcessTree.isAlive(pid)).toBe(true);

    // 2. Simulate session 1 disconnect / shutdown (destroy server1 without killing processes)
    // Server 1 reference is dropped

    // 3. Connect new session 2 against the same persistent StateStore and PID registry
    const pm2 = new ProcessManager({ pidRegistryPath: tempPidPath });
    const gov2 = new SubAgentGovernor({ maxSlots: 3, stateFilePath: tempStatePath });
    const server2 = createHostGovernorServer({ processManager: pm2, subAgentGovernor: gov2 });
    const tools2 = (server2 as any)._registeredTools;

    // 4. Verify process is still alive on host
    expect(await ProcessTree.isAlive(pid)).toBe(true);

    // 5. Verify governor state persisted and was recovered by session 2
    const statusRes2 = await tools2['governor_status'].handler({ modelId: 'recovery-model' });
    const statusData2 = JSON.parse(statusRes2.content[0].text);
    const recoveredModel = statusData2.models.find((m: any) => m.modelId === 'recovery-model');
    expect(recoveredModel).toBeDefined();
    expect(recoveredModel.activeSlots).toBe(1);

    // 6. Release slot via session 2
    const relRes = await tools2['governor_release_slot'].handler({ leaseId });
    expect(JSON.parse(relRes.content[0].text).released).toBe(true);

    // Clean up process
    await ProcessTree.terminate(pid, true);
  });
});
