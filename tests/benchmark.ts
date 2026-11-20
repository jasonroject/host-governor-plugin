import { ProcessManager } from '../src/core/process-manager.js';
import { SubAgentGovernor } from '../src/core/subagent-governor.js';
import { createHostGovernorServer } from '../src/adapters/mcp-server.js';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

async function runBenchmarks() {
  console.log('====================================================');
  console.log('   HOST GOVERNOR SYSTEMATIC UPGRADE BENCHMARKS');
  console.log('====================================================\n');

  // Benchmark 1: Process Startup Overhead
  console.log('--- 1. Process Startup Overhead ---');
  const pm = new ProcessManager();
  const startupTimes: number[] = [];
  const iterations = 20;

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const proc = pm.startProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)']
    });
    startupTimes.push(performance.now() - start);
  }

  // Wait 1s for all to close
  await new Promise((r) => setTimeout(r, 1000));

  const avgStartupMs = startupTimes.reduce((a, b) => a + b, 0) / startupTimes.length;
  const minStartupMs = Math.min(...startupTimes);
  const maxStartupMs = Math.max(...startupTimes);
  console.log(`Process Spawn + Registration: avg = ${avgStartupMs.toFixed(2)}ms (min = ${minStartupMs.toFixed(2)}ms, max = ${maxStartupMs.toFixed(2)}ms)\n`);

  // Benchmark 2: MCP Request Latency (Internal Tool Handler Round-Trip)
  console.log('--- 2. MCP Request Latency ---');
  const server = createHostGovernorServer({ processManager: pm });
  const tools = (server as any)._registeredTools;
  const statusHandler = tools['governor_status'].handler;
  const mcpLatencies: number[] = [];

  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await statusHandler({});
    mcpLatencies.push(performance.now() - start);
  }

  const avgMcpMs = mcpLatencies.reduce((a, b) => a + b, 0) / mcpLatencies.length;
  const minMcpMs = Math.min(...mcpLatencies);
  const maxMcpMs = Math.max(...mcpLatencies);
  console.log(`MCP Tool Dispatch (governor_status): avg = ${avgMcpMs.toFixed(3)}ms (min = ${minMcpMs.toFixed(3)}ms, max = ${maxMcpMs.toFixed(3)}ms)\n`);

  // Benchmark 3: Sub-Agent Task Scheduling Latency (File-Backed StateStore)
  console.log('--- 3. Sub-Agent Scheduling Latency (File-Backed StateStore) ---');
  const benchStatePath = path.join(os.tmpdir(), `bench-gov-state-${Date.now()}.json`);
  const gov = new SubAgentGovernor({ maxSlots: 3, stateFilePath: benchStatePath });
  const scheduleTimes: number[] = [];

  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    const slot = await gov.acquireSlot({
      modelId: 'bench-model',
      subAgentName: `Agent-${i}`,
      timeoutMs: 0
    });
    scheduleTimes.push(performance.now() - start);

    if (slot.granted && slot.leaseId) {
      gov.releaseSlot(slot.leaseId);
    }
  }

  const avgScheduleMs = scheduleTimes.reduce((a, b) => a + b, 0) / scheduleTimes.length;
  const minScheduleMs = Math.min(...scheduleTimes);
  const maxScheduleMs = Math.max(...scheduleTimes);
  console.log(`Lease Acquisition + Release (File-Backed): avg = ${avgScheduleMs.toFixed(3)}ms (min = ${minScheduleMs.toFixed(3)}ms, max = ${maxScheduleMs.toFixed(3)}ms)\n`);

  try {
    if (fs.existsSync(benchStatePath)) fs.unlinkSync(benchStatePath);
    if (fs.existsSync(`${benchStatePath}.lock`)) fs.unlinkSync(`${benchStatePath}.lock`);
  } catch {}

  // Benchmark 4: Memory Footprint under Sustained Workload
  console.log('--- 4. Memory Footprint Under Sustained Workload ---');
  const initialHeap = process.memoryUsage().heapUsed;
  const procForMem = pm.startProcess({
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    logBufferSize: 500
  });

  const buf = (pm as any).logBuffers.get(procForMem.processId);
  const logEvents = 100000;
  for (let i = 0; i < logEvents; i++) {
    buf.append('stdout', `Benchmark log entry iteration #${i} with payload data`);
  }

  const finalHeap = process.memoryUsage().heapUsed;
  const heapDiffMb = (finalHeap - initialHeap) / (1024 * 1024);
  console.log(`Heap Delta after 100,000 log events: ${heapDiffMb.toFixed(2)} MB (Bounded ring buffer active)\n`);

  // Benchmark 5: Maximum Stable Concurrent Process Load
  console.log('--- 5. Concurrent Process Scalability ---');
  const concurrentTarget = 25;
  const concurrentProcs = [];
  const t0 = performance.now();

  for (let i = 0; i < concurrentTarget; i++) {
    const p = pm.startProcess({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      tag: `concurrent-${i}`
    });
    concurrentProcs.push(p);
  }

  await new Promise((r) => setTimeout(r, 2000));
  const completedCount = pm.listProcesses().filter((p) => p.state === 'completed').length;
  const totalDuration = performance.now() - t0;
  console.log(`Executed ${concurrentTarget} concurrent processes in ${totalDuration.toFixed(1)}ms. Total completed: ${completedCount}/${concurrentTarget}\n`);

  // Benchmark 6: Sub-Agent Concurrency Enforcement Accuracy
  console.log('--- 6. Sub-Agent Concurrency Enforcement Accuracy ---');
  let grantedCount = 0;
  let rejectedCount = 0;
  const targetModel = 'stress-quota-model';

  for (let i = 0; i < 50; i++) {
    const res = await gov.acquireSlot({
      modelId: targetModel,
      subAgentName: `Burst-Agent-${i}`,
      timeoutMs: 0
    });
    if (res.granted) {
      grantedCount++;
    } else {
      rejectedCount++;
    }
  }

  console.log(`Burst Requests: 50 | Granted: ${grantedCount} (Max cap: 3) | Rejected: ${rejectedCount}`);
  console.log(`Enforcement Accuracy: ${grantedCount === 3 && rejectedCount === 47 ? '100% (Strictly 3 active, 0 overflow)' : 'Violation'}\n`);

  console.log('====================================================');
  console.log('   BENCHMARK RUN COMPLETED (ALL 6 METRICS TRACKED)');
  console.log('====================================================');
}

runBenchmarks().catch(console.error);
