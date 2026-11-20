#!/usr/bin/env node

/**
 * Antigravity PreToolUse / PostToolUse Hook Handler
 * Integrates directly with Antigravity hooks.json to intercept invoke_subagent.
 */

import fs from 'node:fs';
import { SubAgentGovernor } from '../core/subagent-governor.js';

async function main() {
  const governor = new SubAgentGovernor();

  // Read stdin JSON from Antigravity Language Server
  let inputBuffer = '';
  process.stdin.setEncoding('utf-8');

  for await (const chunk of process.stdin) {
    inputBuffer += chunk;
  }

  if (!inputBuffer.trim()) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
    return;
  }

  try {
    const payload = JSON.parse(inputBuffer);
    const eventName = payload.hookEventName; // 'PreToolUse' or 'PostToolUse'
    const toolCall = payload.toolCall;

    if (!toolCall || toolCall.name !== 'invoke_subagent') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
      return;
    }

    const modelId = (toolCall.args?.Model || payload.modelName || 'inherit').toLowerCase();
    const role = toolCall.args?.Role || 'SubAgent';

    if (eventName === 'PreToolUse') {
      // Evaluate concurrency slot
      const result = await governor.acquireSlot({
        modelId,
        subAgentName: role,
        timeoutMs: 0 // Non-blocking check for harness gate
      });

      if (!result.granted) {
        process.stdout.write(
          JSON.stringify({
            decision: 'deny',
            reason: `[Host Governor] Sub-agent concurrency cap reached: Model '${modelId}' already has ${result.activeCount}/${result.maxSlots} active sub-agents. Sequential scheduling required.`
          })
        );
        return;
      }

      // Granted
      process.stdout.write(
        JSON.stringify({
          decision: 'allow',
          reason: `[Host Governor] Slot granted (${result.activeCount}/${result.maxSlots})`
        })
      );
      return;
    }

    // Default allow for other events
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  } catch (err) {
    // Fail safe: allow execution on hook parse error so agent is not stranded
    console.error('[host-governor hook error]', err);
    process.stdout.write(JSON.stringify({ decision: 'allow' }));
  }
}

main();
