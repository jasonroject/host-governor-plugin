# Host Process & Sub-Agent Governor: Deployment & Rollback Guide

## 1. Overview & Guardrails

This guide covers building, configuring, deploying, and rolling back the **Host Process & Sub-Agent Governor** plugin.

### Key Guardrails
- **Self-Preservation**: Never overwrite or terminate the active plugin process while an Antigravity or Codex session is using it. Always build in the scratch workspace first and verify tests pass.
- **Clean Fallback**: Maintain the pre-upgrade backup at all times.
- **Protected Configs**: Never modify global Harness configs (`~/.gemini/config/` or `~/.codex/`) without explicit user review.

---

## 2. Configuration Environment Variables

The plugin is fully configurable via standard environment variables:

| Variable | Default Value | Description |
|---|---|---|
| `MAX_SUBAGENTS_PER_MODEL` | `3` | Maximum concurrent sub-agents permitted per model family. |
| `MAX_ACTIVE_PROCESSES` | `50` | Maximum concurrent host background processes permitted simultaneously. |
| `GOVERNOR_STATE_FILE` | `~/.gemini/antigravity/.governor-state.json` | Path to shared cross-instance atomic JSON state store. |
| `GOVERNOR_ALLOWED_ROOTS` | *Empty (Unrestricted)* | Comma-separated list of absolute directory paths allowed for process `cwd`. |
| `GOVERNOR_GRACE_PERIOD_MS` | `1500` | Grace period in milliseconds before escalating to force kill (`taskkill /f` / `SIGKILL`). |
| `GOVERNOR_IDEMPOTENCY_TTL_MS`| `60000` | Time window in milliseconds for caching idempotency keys against duplicate retries. |

---

## 3. Build & Test Verification

All compilation and testing must occur in the workspace repository:

```powershell
# Navigate to workspace directory
Set-Location "<WORKSPACE_DIR>/host-governor-plugin"

# 1. Install dependencies
npm install

# 2. Compile TypeScript
npm run build

# 3. Execute all 8 test suites (29 tests)
npm test

# 4. Run performance benchmark suite (all 6 tracked metrics)
npx tsx tests/benchmark.ts
```

All 29 tests must pass and `tsc` must exit with code 0 before proceeding to deployment.

---

## 4. Production Deployment

### 4.1 Deployment Target
- **Live Antigravity Plugin Directory**: `~/.gemini/config/plugins/host-governor`
- **Backup Location**: `~/.gemini/antigravity/backups/host-governor.backup-<TIMESTAMP>`

### 4.2 Safe Deployment Procedure
When authorized by the user to deploy into the live plugin directory:

```powershell
$SourceDir = "<WORKSPACE_DIR>/host-governor-plugin"
$TargetDir = "$HOME/.gemini/config/plugins/host-governor"
$BackupDir = "$HOME/.gemini/antigravity/backups/host-governor.backup-" + (Get-Date -Format "yyyyMMdd-HHmmss")

# 1. Create a fresh safety backup of the existing live directory
Copy-Item -Path $TargetDir -Destination $BackupDir -Recurse -Force
Write-Host "Created fresh backup at: $BackupDir"

# 2. Deploy compiled dist/ bundle and package.json to live directory
Copy-Item -Path "$SourceDir\dist" -Destination "$TargetDir\dist" -Recurse -Force
Copy-Item -Path "$SourceDir\package.json" -Destination "$TargetDir\package.json" -Force

# 3. If docs are desired in the plugin folder:
if (-not (Test-Path "$TargetDir\docs")) { New-Item -ItemType Directory -Path "$TargetDir\docs" }
Copy-Item -Path "$SourceDir\docs\*" -Destination "$TargetDir\docs" -Recurse -Force

Write-Host "Deployment completed successfully."
```

---

## 5. Post-Deployment Verification

After deploying, verify that the plugin functions properly:

1. **Verify MCP Initialization**:
   Ensure the plugin starts without writing any non-JSON messages to `stdout`.
2. **Execute Diagnostic Check**:
   Issue tool call `governor_diagnose` from the Harness:
   ```json
   {
     "name": "governor_diagnose",
     "arguments": {}
   }
   ```
   Check that `concurrencyStatus.configuredMaxPerModel` reports `3` and `processSummary` reports active metrics.
3. **Verify Slot Enforcement**:
   Call `governor_acquire_slot` 4 times with the same model (e.g. `test-model`).
   The first 3 calls should return `granted: true`, and the 4th should return `granted: false` with reason `CONCURRENCY_LIMIT_REACHED`.
4. **Verify Slot Release**:
   Call `governor_release_slot` with one of the active lease IDs. Verify that the 4th call can now be granted.

---

## 6. One-Line Rollback Procedure

If any regression or incompatibility is observed, execute the immediate one-line rollback command in PowerShell:

```powershell
# Restore from the verified baseline backup
Copy-Item -Path "$HOME/.gemini/antigravity/backups/<BACKUP_NAME>/*" -Destination "$HOME/.gemini/config/plugins/host-governor" -Recurse -Force
```

This immediately restores the exact pre-upgrade state with zero configuration loss.
