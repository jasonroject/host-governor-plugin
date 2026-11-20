import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ProcessManager } from '../core/process-manager.js';
import { SubAgentGovernor } from '../core/subagent-governor.js';
import { GovernorStatusReport, PriorityLevel } from '../core/types.js';

export function createHostGovernorServer(options?: {
  processManager?: ProcessManager;
  subAgentGovernor?: SubAgentGovernor;
}) {
  const pm = options?.processManager || new ProcessManager();
  const gov = options?.subAgentGovernor || new SubAgentGovernor();

  const server = new McpServer({
    name: 'host-governor',
    version: '2.0.0'
  });

  const prioritySchema = z.enum(['low', 'normal', 'high', 'critical'] as const).optional();

  // Tool 1: host_exec_start
  server.tool(
    'host_exec_start',
    'Spawn a software process running locally on the host machine in the background.',
    {
      command: z.string().describe('The executable or command to run (e.g. "npm", "python", "docker", "cargo").'),
      args: z.array(z.string()).optional().describe('Command-line arguments.'),
      cwd: z.string().optional().describe('Working directory. Defaults to current workspace.'),
      tag: z.string().optional().describe('Optional human-readable label or purpose for this process.'),
      timeoutMs: z.number().optional().describe('Execution timeout in milliseconds. If exceeded, automatically terminates.'),
      priority: prioritySchema.describe('Task scheduling priority (low, normal, high, critical).'),
      logBufferSize: z.number().optional().describe('Max stdout/stderr lines to buffer in memory (default: 2000).'),
      allowShell: z.boolean().optional().describe('Whether to execute within a shell (cmd.exe or /bin/sh). Defaults to false for injection safety.'),
      spillToFile: z.boolean().optional().describe('Spill output to temporary disk file to protect memory on large builds.')
    },
    async ({ command, args, cwd, tag, timeoutMs, priority, logBufferSize, allowShell, spillToFile }) => {
      try {
        const proc = pm.startProcess({
          command,
          args,
          cwd,
          tag,
          timeoutMs,
          priority: priority as PriorityLevel,
          logBufferSize,
          allowShell,
          spillToFile
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  processId: proc.processId,
                  pid: proc.pid,
                  state: proc.state,
                  startTime: proc.startTime,
                  timeoutMs: proc.timeoutMs,
                  spillFilePath: proc.spillFilePath,
                  message: `Process '${command}' started with PID ${proc.pid} [State: ${proc.state}].`
                },
                null,
                2
              )
            }
          ]
        };
      } catch (err: any) {
        console.error('[host-governor] Error starting process:', err);
        let code = 'ERR_SPAWN_FAILED';
        if (err.message?.includes('ERR_RESOURCE_LIMIT_EXCEEDED')) code = 'ERR_RESOURCE_LIMIT_EXCEEDED';
        else if (err.message?.includes('ERR_PATH_RESTRICTED')) code = 'ERR_PATH_RESTRICTED';
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: {
                  code,
                  message: String(err.message || err)
                }
              }, null, 2)
            }
          ]
        };
      }
    }
  );

  // Tool 2: host_exec_status
  server.tool(
    'host_exec_status',
    'Get status, exit code, state history, and runtime info of a background process, or list all running processes.',
    {
      processId: z.string().optional().describe('Process ID to inspect. If omitted, lists all managed processes.')
    },
    async ({ processId }) => {
      if (processId) {
        const proc = pm.getProcess(processId);
        if (!proc) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Process with ID '${processId}' not found.` }]
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  processId: proc.processId,
                  pid: proc.pid,
                  command: proc.command,
                  args: proc.args,
                  cwd: proc.cwd,
                  tag: proc.tag,
                  state: proc.state,
                  exitCode: proc.exitCode,
                  startTime: proc.startTime,
                  endTime: proc.endTime,
                  stateHistory: proc.stateHistory,
                  logCount: proc.logs.length,
                  spillFilePath: proc.spillFilePath
                },
                null,
                2
              )
            }
          ]
        };
      }

      const all = pm.listProcesses().map((p) => ({
        processId: p.processId,
        pid: p.pid,
        command: p.command,
        state: p.state,
        exitCode: p.exitCode,
        tag: p.tag,
        startTime: p.startTime
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify({ total: all.length, processes: all }, null, 2) }]
      };
    }
  );

  // Tool 3: host_exec_logs
  server.tool(
    'host_exec_logs',
    'Read captured stdout, stderr, and system logs from a background host process (with secret redaction).',
    {
      processId: z.string().describe('Process ID to inspect logs for.'),
      tail: z.number().optional().describe('Number of recent log lines to retrieve (default: 100).'),
      sinceTimestamp: z.string().optional().describe('ISO timestamp to filter logs after.')
    },
    async ({ processId, tail, sinceTimestamp }) => {
      const proc = pm.getProcess(processId);
      if (!proc) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Process '${processId}' not found.` }]
        };
      }

      const logs = pm.getLogs(processId, tail || 100, sinceTimestamp);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                processId,
                state: proc.state,
                exitCode: proc.exitCode,
                returnedLines: logs.length,
                spillFilePath: proc.spillFilePath,
                logs
              },
              null,
              2
            )
          }
        ]
      };
    }
  );

  // Tool 4: host_exec_input
  server.tool(
    'host_exec_input',
    'Send stdin text to an active interactive background process.',
    {
      processId: z.string().describe('Process ID.'),
      input: z.string().describe('Text/keystrokes to send to stdin.')
    },
    async ({ processId, input }) => {
      const success = pm.sendInput(processId, input);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ processId, success, message: success ? 'Input sent.' : 'Failed to send input (process not active).' })
          }
        ]
      };
    }
  );

  // Tool 5: host_exec_stop
  server.tool(
    'host_exec_stop',
    'Stop or kill a running background host process and its entire child process tree.',
    {
      processId: z.string().describe('Process ID to terminate.'),
      force: z.boolean().optional().describe('Whether to force kill (SIGKILL/taskkill /F). Defaults to false.')
    },
    async ({ processId, force }) => {
      const success = await pm.stopProcess(processId, force ?? false);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ processId, terminated: success })
          }
        ]
      };
    }
  );

  // Tool 6: governor_acquire_slot
  server.tool(
    'governor_acquire_slot',
    'Acquire a sub-agent concurrency slot. Strictly enforces a limit of no more than 3 active sub-agents per AI model (cross-instance safe).',
    {
      modelId: z.string().describe('Identifier of the AI model being used (e.g. "gemini-3.8-flash", "gemini-2.5-pro", "o3", "claude-3-7-sonnet").'),
      subAgentName: z.string().describe('Role or title of the sub-agent (e.g. "Codebase Researcher", "Unit Tester").'),
      priority: prioritySchema.describe('Queue priority (low, normal, high, critical). Defaults to normal.'),
      idempotencyKey: z.string().optional().describe('Optional unique key to prevent duplicate lease grants on client retries.'),
      leaseTtlSeconds: z.number().optional().describe('Safety TTL for this lease in seconds before automatic release (default: 600s).'),
      timeoutMs: z.number().optional().describe('Max milliseconds to wait in priority queue if capacity is full (default: 0 = immediate reject).')
    },
    async ({ modelId, subAgentName, priority, idempotencyKey, leaseTtlSeconds, timeoutMs }) => {
      const outcome = await gov.acquireSlot({
        modelId,
        subAgentName,
        priority: priority as PriorityLevel,
        idempotencyKey,
        leaseTtlSeconds,
        timeoutMs
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(outcome, null, 2)
          }
        ]
      };
    }
  );

  // Tool 7: governor_release_slot
  server.tool(
    'governor_release_slot',
    'Release a previously acquired sub-agent slot, unblocking pending queued sub-agents for that model.',
    {
      leaseId: z.string().describe('The lease ID returned by governor_acquire_slot.')
    },
    async ({ leaseId }) => {
      const result = gov.releaseSlot(leaseId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    }
  );

  // Tool 8: governor_status
  server.tool(
    'governor_status',
    'Inspect the current governor state: active sub-agents per model, queue depths, and running host background processes.',
    {
      modelId: z.string().optional().describe('Optional model filter.')
    },
    async ({ modelId }) => {
      const models = gov.getModelMetrics(modelId);
      const metrics = pm.getMetrics();
      const runningProcesses = pm.listProcesses().filter((p) => p.state === 'running');

      const report: GovernorStatusReport = {
        timestamp: new Date().toISOString(),
        policy: {
          maxSubAgentsPerModel: gov.getMaxSlots(),
          crossInstanceShared: true
        },
        metrics: {
          totalProcessesTracked: metrics.totalCreated,
          activeProcesses: metrics.activeProcesses,
          completedProcesses: metrics.totalCompleted,
          failedProcesses: metrics.totalFailed,
          timedOutProcesses: metrics.totalTimedOut
        },
        models,
        activeProcesses: runningProcesses.map((p) => ({
          processId: p.processId,
          pid: p.pid,
          command: p.command,
          state: p.state,
          uptimeSeconds: Math.round((Date.now() - new Date(p.startTime).getTime()) / 1000),
          tag: p.tag
        }))
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(report, null, 2) }]
      };
    }
  );

  // Tool 9: governor_diagnose (New Observability Diagnostic Tool)
  server.tool(
    'governor_diagnose',
    'Run deep diagnostics on the host execution environment, active sub-agent locks, and resource utilization.',
    {},
    async () => {
      const models = gov.getModelMetrics();
      const metrics = pm.getMetrics();

      const diagnostics = {
        timestamp: new Date().toISOString(),
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        pid: process.pid,
        memoryUsage: process.memoryUsage(),
        processSummary: metrics,
        concurrencyStatus: {
          configuredMaxPerModel: gov.getMaxSlots(),
          totalModelsTracked: models.length,
          modelsAtCapacity: models.filter((m) => m.availableSlots === 0).map((m) => m.modelId),
          totalQueuedRequests: models.reduce((acc, m) => acc + m.queuedRequests, 0)
        }
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(diagnostics, null, 2) }]
      };
    }
  );

  return server;
}
