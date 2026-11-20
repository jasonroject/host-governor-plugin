# Host Process & Sub-Agent Governor: MCP Tool Reference

This document provides complete reference documentation for the 9 tools exposed by the **Host Process & Sub-Agent Governor** Model Context Protocol (MCP) server (`v2.0.0`).

All tools communicate over standard MCP JSON-RPC 2.0 via `stdio`. All logs and internal diagnostics are written strictly to `stderr`, leaving `stdout` dedicated exclusively to JSON-RPC protocol frames.

---

## Tool Summary Table

| Tool Name | Category | Description | Primary Return Fields |
|---|---|---|---|
| `host_exec_start` | Process Execution | Spawn a background process on the host. | `processId`, `pid`, `state`, `timeoutMs` |
| `host_exec_status` | Process Execution | Get detailed status or list all managed processes. | `processId`, `state`, `exitCode`, `stateHistory` |
| `host_exec_logs` | Process Execution | Read bounded, secret-redacted stdout/stderr. | `processId`, `logs`, `returnedLines`, `spillFilePath` |
| `host_exec_input` | Process Execution | Send stdin text/keystrokes to an interactive process. | `processId`, `success`, `message` |
| `host_exec_stop` | Process Execution | Terminate a process and its entire child process tree. | `processId`, `terminated` |
| `governor_acquire_slot` | Sub-Agent Concurrency | Acquire a sub-agent execution slot (max 3/model). | `granted`, `leaseId`, `reason`, `activeCount` |
| `governor_release_slot` | Sub-Agent Concurrency | Release an acquired slot, unblocking queued requests. | `success`, `releasedLeaseId`, `remainingActive` |
| `governor_status` | Observability | Inspect concurrency usage and running processes. | `policy`, `metrics`, `models`, `activeProcesses` |
| `governor_diagnose` | Observability | Run deep diagnostics on host environment & memory. | `platform`, `memoryUsage`, `concurrencyStatus` |

---

## 1. Process Execution Tools

### 1.1 `host_exec_start`
Spawns a software process running locally on the host machine in the background.

#### Parameters
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `command` | `string` | **Yes** | - | Executable or binary name (e.g., `npm`, `python`, `cargo`, `docker`). |
| `args` | `string[]` | No | `[]` | List of command-line arguments. |
| `cwd` | `string` | No | Workspace root | Working directory. Subject to path confinement rules if configured. |
| `tag` | `string` | No | `""` | Human-readable tag or purpose (e.g., `dev-server`, `unit-tests`). |
| `timeoutMs` | `number` | No | `0` (none) | Execution timeout in ms. If exceeded, the process is terminated and transitions to `timed_out`. |
| `priority` | `"low"` \| `"normal"` \| `"high"` \| `"critical"` | No | `"normal"` | Task scheduling priority. |
| `logBufferSize` | `number` | No | `2000` | Maximum memory lines retained (head 200 + tail ring). |
| `allowShell` | `boolean` | No | `false` | When `false`, uses direct execution (`child_process.spawn`) preventing shell injection. Set `true` only when shell built-ins or redirection are required. |
| `spillToFile` | `boolean` | No | `false` | Spills large logs to a temporary file to conserve RAM on large builds. |

#### Example Request
```json
{
  "name": "host_exec_start",
  "arguments": {
    "command": "npm",
    "args": ["run", "build"],
    "tag": "production-build",
    "timeoutMs": 60000,
    "priority": "high",
    "spillToFile": true
  }
}
```

#### Example Response (Success)
```json
{
  "success": true,
  "processId": "proc_1710920000000_abcd1234",
  "pid": 14228,
  "state": "running",
  "startTime": "2026-11-20T08:00:00.000Z",
  "timeoutMs": 60000,
  "spillFilePath": "<TEMP_DIR>/proc_1710920000000_abcd1234.log",
  "message": "Process 'npm' started with PID 14228 [State: running]."
}
```

#### Structured Error Response
```json
{
  "isError": true,
  "error": {
    "code": "ERR_RESOURCE_LIMIT_EXCEEDED",
    "message": "Maximum active process limit (50) exceeded."
  }
}
```

---

### 1.2 `host_exec_status`
Queries the status, exit code, state history, and metadata of a background process, or lists all tracked processes.

#### Parameters
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `processId` | `string` | No | `undefined` | ID of the process to inspect. If omitted, returns an array of all processes. |

#### Example Request
```json
{
  "name": "host_exec_status",
  "arguments": {
    "processId": "proc_1710920000000_abcd1234"
  }
}
```

#### Example Response
```json
{
  "processId": "proc_1710920000000_abcd1234",
  "pid": 14228,
  "command": "npm",
  "args": ["run", "build"],
  "cwd": "/path/to/workspace",
  "tag": "production-build",
  "state": "completed",
  "exitCode": 0,
  "startTime": "2026-11-20T08:00:00.000Z",
  "endTime": "2026-11-20T08:00:08.500Z",
  "stateHistory": [
    { "from": "created", "to": "running", "timestamp": "2026-11-20T08:00:00.005Z" },
    { "from": "running", "to": "completed", "timestamp": "2026-11-20T08:00:08.500Z", "reason": "Process exited with code 0" }
  ],
  "logCount": 42,
  "spillFilePath": null
}
```

---

### 1.3 `host_exec_logs`
Retrieves captured `stdout`, `stderr`, and system log events with automatic credential redaction.

#### Parameters
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `processId` | `string` | **Yes** | - | ID of the process to read logs from. |
| `tail` | `number` | No | `100` | Number of most recent lines to retrieve. |
| `sinceTimestamp` | `string` | No | `undefined` | ISO 8601 timestamp; returns only lines emitted after this time. |

#### Example Response
```json
{
  "processId": "proc_1710920000000_abcd1234",
  "state": "running",
  "exitCode": null,
  "returnedLines": 2,
  "spillFilePath": null,
  "logs": [
    {
      "source": "stdout",
      "text": "Building TypeScript package in /path/to/workspace",
      "timestamp": "2026-11-20T08:00:01.000Z"
    },
    {
      "source": "stdout",
      "text": "Compiled successfully in 1.4s.",
      "timestamp": "2026-11-20T08:00:02.400Z"
    }
  ]
}
```

---

### 1.4 `host_exec_input`
Sends text or keystrokes to the `stdin` stream of an active background process.

#### Parameters
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `processId` | `string` | **Yes** | - | Process ID. |
| `input` | `string` | **Yes** | - | Input string to write (e.g. `"yes\n"`). |

#### Example Response
```json
{
  "processId": "proc_1710920000000_abcd1234",
  "success": true,
  "message": "Input sent."
}
```

---

### 1.5 `host_exec_stop`
Stops or terminates a background process and its entire child process tree.

#### Parameters
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `processId` | `string` | **Yes** | - | ID of the process to terminate. |
| `force` | `boolean` | No | `false` | When `false`, attempts graceful shutdown first with a 1,500ms grace period. When `true`, immediately issues `taskkill /f /t` or `SIGKILL`. |

#### Example Response
```json
{
  "processId": "proc_1710920000000_abcd1234",
  "terminated": true
}
```

---

## 2. Sub-Agent Governance Tools

### 2.1 `governor_acquire_slot`
Acquires a sub-agent concurrency slot. Strictly enforces a cap of **no more than 3 active sub-agents per AI model** across all Harness instances.

#### Parameters
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `modelId` | `string` | **Yes** | - | Model identifier (e.g. `gemini-1.5-pro`, `gpt-4o`, `claude-3-7-sonnet`). |
| `subAgentName` | `string` | **Yes** | - | Role or job title of the sub-agent (e.g. `Codebase Researcher`). |
| `priority` | `"low"` \| `"normal"` \| `"high"` \| `"critical"` | No | `"normal"` | Priority level for queue scheduling. |
| `idempotencyKey` | `string` | No | `undefined` | Unique idempotency token; guarantees retried calls return the active lease without double-counting quota. |
| `leaseTtlSeconds` | `number` | No | `600` | Safety expiration TTL in seconds (prevents leaked slots if an agent crashes). |
| `timeoutMs` | `number` | No | `0` | Queue wait timeout in ms. If `0`, immediately rejects with `granted: false` when full. |

#### Example Response (Granted)
```json
{
  "granted": true,
  "leaseId": "lease_gemini-1.5-pro_1710920000000_5678",
  "modelId": "gemini-1.5-pro",
  "subAgentName": "Codebase Researcher",
  "activeCount": 2,
  "maxAllowed": 3,
  "expiresAt": "2026-11-20T08:10:00.000Z"
}
```

#### Example Response (Rejected / Quota Saturated)
```json
{
  "granted": false,
  "modelId": "gemini-1.5-pro",
  "subAgentName": "Database Migrator",
  "activeCount": 3,
  "maxAllowed": 3,
  "reason": "CONCURRENCY_LIMIT_REACHED: Model 'gemini-1.5-pro' has 3 active sub-agents. Maximum allowed is 3.",
  "queuePosition": null
}
```

---

### 2.2 `governor_release_slot`
Releases an active sub-agent concurrency lease, unblocking any waiting sub-agents in the queue.

#### Parameters
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `leaseId` | `string` | **Yes** | - | The lease ID returned during acquisition. |

#### Example Response
```json
{
  "success": true,
  "releasedLeaseId": "lease_gemini-1.5-pro_1710920000000_5678",
  "modelId": "gemini-1.5-pro",
  "remainingActive": 2
}
```

---

## 3. Observability & Diagnostic Tools

### 3.1 `governor_status`
Returns high-level health metrics, active process counts, and per-model sub-agent utilization.

#### Parameters
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `modelId` | `string` | No | `undefined` | Optional model filter. |

#### Example Response
```json
{
  "timestamp": "2026-11-20T08:00:15.000Z",
  "policy": {
    "maxSubAgentsPerModel": 3,
    "crossInstanceShared": true
  },
  "metrics": {
    "totalProcessesTracked": 12,
    "activeProcesses": 2,
    "completedProcesses": 9,
    "failedProcesses": 1,
    "timedOutProcesses": 0
  },
  "models": [
    {
      "modelId": "gemini-1.5-pro",
      "activeSlots": 2,
      "maxSlots": 3,
      "availableSlots": 1,
      "queuedRequests": 0
    }
  ],
  "activeProcesses": [
    {
      "processId": "proc_1710920000000_abcd1234",
      "pid": 14228,
      "command": "npm",
      "state": "running",
      "uptimeSeconds": 15,
      "tag": "production-build"
    }
  ]
}
```

---

### 3.2 `governor_diagnose`
Runs deep diagnostics on the host system, Node.js memory footprint, platform architecture, and model capacity saturation.

#### Parameters
*None required.*

#### Example Response
```json
{
  "timestamp": "2026-11-20T08:00:20.000Z",
  "nodeVersion": "v22.23.3",
  "platform": "win32",
  "architecture": "x64",
  "pid": 9812,
  "memoryUsage": {
    "rss": 42106880,
    "heapTotal": 20430848,
    "heapUsed": 14930112,
    "external": 1823901
  },
  "processSummary": {
    "totalCreated": 12,
    "activeProcesses": 2,
    "totalCompleted": 9,
    "totalFailed": 1,
    "totalTimedOut": 0
  },
  "concurrencyStatus": {
    "configuredMaxPerModel": 3,
    "totalModelsTracked": 1,
    "modelsAtCapacity": [],
    "totalQueuedRequests": 0
  }
}
```

---

## 4. Structured Error Codes

All errors returned by the governor use standardized structured error objects:

| Error Code | HTTP/MCP Equivalent | Trigger Condition |
|---|---|---|
| `ERR_RESOURCE_LIMIT_EXCEEDED` | 429 Too Many Requests | `MAX_ACTIVE_PROCESSES` (50) or `MAX_SUBAGENTS_PER_MODEL` (3) reached. |
| `ERR_PROCESS_NOT_FOUND` | 404 Not Found | Requested `processId` does not exist in the state tracker. |
| `ERR_INVALID_TRANSITION` | 409 Conflict | Attempted invalid state transition (e.g., stopping an already completed process). |
| `ERR_PATH_RESTRICTED` | 403 Forbidden | Process `cwd` is outside permitted root directories (`GOVERNOR_ALLOWED_ROOTS`). |
| `ERR_SPAWN_FAILED` | 500 Internal Error | OS failed to spawn executable (e.g., `ENOENT` executable not found). |
| `ERR_TIMEOUT` | 504 Gateway Timeout | Process execution exceeded the designated `timeoutMs`. |
