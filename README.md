# Host Process & Sub-Agent Governor (`host-governor-plugin`)

A lightweight Model Context Protocol (MCP) server providing host process supervision, multi-process management, and sub-agent concurrency control for AI agent environments including Google Antigravity and OpenAI Codex.

---

## Key Capabilities

- **Sub-Agent Quota Enforcement**: Strictly caps concurrent sub-agents to a configurable threshold (default: 3 per AI model) across Harness windows via atomic lockfiles and priority queueing.
- **Detached Background Execution**: Spawns and manages asynchronous background software processes without blocking agent tool loops.
- **Process-Tree Termination**: Ensures clean lifecycle management (`taskkill /t` on Windows, POSIX process groups on Unix) with graceful shutdown windows before force killing.
- **Bounded Ring Buffering**: Retains head and tail logs while streaming high-throughput processes without unbounded memory consumption.
- **Automated Secret Redaction**: Masks Bearer tokens, API credentials, and sensitive environment keys from stdout/stderr captures.
- **Cross-Harness Interoperability**: Compatible with Antigravity (`hooks.json` PreToolUse hook) and standard MCP stdio clients.

---

## Quickstart

### Prerequisites
- Node.js (v18 or later)
- npm

### Installation & Build

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run build

# Run Vitest test suite
npm test
```

### Running the MCP Server

```bash
node dist/index.js
```

All JSON-RPC messages are communicated strictly over `stdio`. Diagnostics and internal logs are routed to `stderr`.

---

## MCP Tools Reference

| Tool | Purpose |
|---|---|
| `host_exec_start` | Launch a host process in the background |
| `host_exec_status` | Query state and metadata of running or completed processes |
| `host_exec_logs` | Retrieve bounded, secret-redacted process output |
| `host_exec_input` | Send input to a running interactive process via stdin |
| `host_exec_stop` | Terminate a process and its child process tree |
| `governor_acquire_slot` | Request a sub-agent concurrency lease |
| `governor_release_slot` | Release an active lease and unblock queue |
| `governor_status` | View global concurrency quotas and active processes |
| `governor_diagnose` | Inspect host platform, memory usage, and saturation status |

---

## Documentation

Detailed technical documentation is available in the `docs/` directory:
- [System Architecture](docs/ARCHITECTURE.md)
- [MCP Tool Reference](docs/TOOL_REFERENCE.md)
- [Compatibility Matrix](docs/COMPATIBILITY.md)
- [Deployment & Rollback Guide](docs/DEPLOYMENT_AND_ROLLBACK.md)

---

## License

MIT License. See [LICENSE](LICENSE) for details.
