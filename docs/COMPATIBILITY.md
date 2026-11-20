# Host Process & Sub-Agent Governor: Compatibility Matrix

## 1. Operating System Compatibility

The plugin is architected for cross-platform portability across Windows, Linux, and macOS.

| Capability | Windows (Win32 x64/arm64) | Linux (x64/arm64) | macOS (Darwin x64/arm64) |
|---|---|---|---|
| **Process Tree Killing** | `taskkill /pid <PID> /t` (Graceful first, then `/f`) | `process.kill(-pid, 'SIGTERM')` followed by `SIGKILL` | `process.kill(-pid, 'SIGTERM')` followed by `SIGKILL` |
| **Process Grouping** | Default detached Windows process group | `detached: true` with POSIX process group | `detached: true` with POSIX process group |
| **Cross-Instance File Locking** | Atomic `'wx'` flag + retry on `EPERM`/`EBUSY` | Atomic `'wx'` flag + standard POSIX file locking | Atomic `'wx'` flag + standard POSIX file locking |
| **Path Separators & CWD** | Normalized via `path.resolve` / `path.normalize` | Normalized via `path.resolve` | Normalized via `path.resolve` |
| **Output Encoding** | UTF-8 with automatic fallback handling | UTF-8 native | UTF-8 native |
| **Orphan PID Verification** | `tasklist /fi "PID eq ..."` / Win32 API check | `kill -0 <PID>` | `kill -0 <PID>` |

---

## 2. AI Agent Harness Compatibility

| Harness Environment | Integration Method | Sub-Agent Concurrency Enforcement | Background Process Supervision |
|---|---|---|---|
| **Google Antigravity (App / IDE)** | Native Plugin / MCP Server over `stdio` | **Tier 1 & Tier 2**: Cooperative via MCP tools + Automated via `PreToolUse` hook (`hooks.json`). | Full support (unref'd detached processes, bounded logs, interactive stdin). |
| **Google Antigravity (`agy` CLI)** | Native Plugin / MCP Server over `stdio` | **Tier 1 & Tier 2**: Cooperative via MCP tools + Automated via `PreToolUse` hook. | Full support with zero terminal `stdout` interference. |
| **OpenAI Codex CLI** | MCP Server (`mcpServers` in configuration) | **Tier 1**: Cooperative via MCP tools (`governor_acquire_slot`). Excess requests queued or denied. | Full support for background test/dev runs. |
| **Codex Desktop** | MCP Server (`stdio` transport) | **Tier 1**: Cooperative via MCP tools (`governor_acquire_slot`). Shared cross-instance lockfile. | Full support. |

---

## 3. Harness Integration Guides

### 3.1 Google Antigravity Integration

In Antigravity, the plugin functions as both an MCP tool provider and a safety rule / hook provider:

1. **MCP Server Registration**:
   In `antigravity.json` or plugin manifest:
   ```json
   {
     "mcpServers": {
       "host-governor": {
         "command": "node",
         "args": ["dist/index.js"]
       }
     }
   }
   ```
2. **Pre-Tool-Use Interception Hook**:
   In `hooks.json`, register the pre-tool-use hook:
   ```json
   {
     "hooks": {
       "PreToolUse": [
         {
           "tool": "invoke_subagent",
           "script": "node dist/adapters/antigravity-hook.js"
         }
       ]
     }
   }
   ```
   When capacity for the target model is reached, the hook intercepts the invocation before execution and returns:
   ```json
   {
     "decision": "deny",
     "reason": "CONCURRENCY_LIMIT_REACHED: Model '...' has 3 active sub-agents. Maximum allowed is 3."
   }
   ```

### 3.2 OpenAI Codex CLI Integration

In OpenAI Codex CLI, configure the MCP server in `~/.codex/config.json` (or pass via `--mcp`):

```json
{
  "mcpServers": {
    "host-governor": {
      "command": "node",
      "args": ["<path-to-host-governor>/dist/index.js"]
    }
  }
}
```

Codex sub-agents or orchestrator prompts can acquire slots before launching sub-agents:
```
Call governor_acquire_slot with modelId="o3" and subAgentName="Refactoring Agent".
If granted is true, proceed. If granted is false, wait or run tasks sequentially.
When done, call governor_release_slot with the leaseId.
```

---

## 4. Backward Compatibility Guarantee (v1 -> v2)

The upgrade to v2 is **100% backward compatible** with legacy v1 integrations:

1. **Re-Export Bridges**:
   Legacy v1 import paths continue to work without modification:
   - `import { ProcessManager } from './process-manager';` -> re-exported from `src/core/process-manager.js`
   - `import { SubAgentGovernor } from './subagent-governor';` -> re-exported from `src/core/subagent-governor.js`
   - `import { ... } from './types';` -> re-exported from `src/core/types.js`
2. **MCP Tool Schema Preservation**:
   All original 8 MCP tools retain their exact names, parameter names, and core response formats. New parameters (such as `timeoutMs`, `priority`, `idempotencyKey`, `allowShell`, `spillToFile`) are strictly optional with sensible backward-compatible defaults.
3. **Additive Enhancements**:
   Tool 9 (`governor_diagnose`) is strictly additive and introduces no breaking changes to existing client code.
