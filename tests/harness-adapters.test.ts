import { describe, it, expect, afterEach } from 'vitest';
import { SubAgentGovernor } from '../src/core/subagent-governor.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

describe('Suite 8: Cross-Harness Compatibility (Antigravity & Codex)', () => {
  const hookScript = path.resolve('dist/adapters/antigravity-hook.js');
  const tempFilesToClean: string[] = [];

  afterEach(() => {
    for (const f of tempFilesToClean) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
        if (fs.existsSync(`${f}.lock`)) fs.unlinkSync(`${f}.lock`);
      } catch {}
    }
    tempFilesToClean.length = 0;
  });

  it('should evaluate Antigravity PreToolUse hook and return deny when quota reached', async () => {
    const testState = path.join(os.tmpdir(), `test-hook-state-${Date.now()}.json`);
    tempFilesToClean.push(testState);
    const gov = new SubAgentGovernor({ maxSlots: 3, stateFilePath: testState });

    // Pre-fill model quota (3 slots)
    await gov.acquireSlot({ modelId: 'gemini-3.8-flash', subAgentName: 'Existing1' });
    await gov.acquireSlot({ modelId: 'gemini-3.8-flash', subAgentName: 'Existing2' });
    await gov.acquireSlot({ modelId: 'gemini-3.8-flash', subAgentName: 'Existing3' });

    // Execute compiled hook over stdio
    const child = spawn(process.execPath, [hookScript], {
      env: {
        ...process.env,
        GOVERNOR_STATE_FILE: testState
      }
    });

    const mockAntigravityPayload = {
      hookEventName: 'PreToolUse',
      toolCall: {
        name: 'invoke_subagent',
        args: {
          Model: 'gemini-3.8-flash',
          Role: 'OverflowSubAgent',
          Prompt: 'Run unit test'
        }
      }
    };

    let stdoutData = '';
    child.stdout.on('data', (d) => {
      stdoutData += d.toString();
    });

    child.stdin.write(JSON.stringify(mockAntigravityPayload));
    child.stdin.end();

    await new Promise((resolve) => child.on('close', resolve));

    expect(stdoutData.trim()).not.toBe('');
    const result = JSON.parse(stdoutData.trim());
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Sub-agent concurrency cap reached');
  });

  it('should evaluate Antigravity PreToolUse hook and return allow when capacity available', async () => {
    const testState = path.join(os.tmpdir(), `test-hook-state-allow-${Date.now()}.json`);
    tempFilesToClean.push(testState);

    const child = spawn(process.execPath, [hookScript], {
      env: {
        ...process.env,
        GOVERNOR_STATE_FILE: testState
      }
    });

    const mockAntigravityPayload = {
      hookEventName: 'PreToolUse',
      toolCall: {
        name: 'invoke_subagent',
        args: {
          Model: 'gemini-3.8-flash',
          Role: 'FreshSubAgent',
          Prompt: 'Run unit test'
        }
      }
    };

    let stdoutData = '';
    child.stdout.on('data', (d) => {
      stdoutData += d.toString();
    });

    child.stdin.write(JSON.stringify(mockAntigravityPayload));
    child.stdin.end();

    await new Promise((resolve) => child.on('close', resolve));

    const result = JSON.parse(stdoutData.trim());
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('Slot granted');
  });
});
