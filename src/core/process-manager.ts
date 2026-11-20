import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { 
  ManagedProcessRecord, 
  ProcessOptions, 
  ProcessState, 
  ProcessLogEntry 
} from './types.js';
import { ProcessStateMachine } from './state-machine.js';
import { BoundedLogBuffer } from './bounded-buffer.js';
import { ProcessTree } from './process-tree.js';
import { SecurityGuard } from './security-guard.js';

interface RegisteredPidInfo {
  pid: number;
  parentPid: number;
  command: string;
  startTimeMs: number;
  processId: string;
}

export class ProcessManager {
  private processes = new Map<string, ManagedProcessRecord>();
  private stateMachines = new Map<string, ProcessStateMachine>();
  private logBuffers = new Map<string, BoundedLogBuffer>();
  private processHandles = new Map<string, ChildProcess>();
  private executionTimers = new Map<string, NodeJS.Timeout>();
  private readonly pidRegistryPath: string;
  private readonly maxActiveProcesses: number;

  // Metrics
  private totalCreated = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalTimedOut = 0;

  constructor(options?: { pidRegistryPath?: string; maxActiveProcesses?: number }) {
    this.pidRegistryPath = options?.pidRegistryPath || process.env.GOVERNOR_PID_REGISTRY || path.join(os.tmpdir(), '.host-governor-active-pids.json');
    const envCap = process.env.MAX_ACTIVE_PROCESSES ? parseInt(process.env.MAX_ACTIVE_PROCESSES, 10) : NaN;
    this.maxActiveProcesses = options?.maxActiveProcesses || (!isNaN(envCap) && envCap > 0 ? envCap : 50);
    // Startup check: discover and safely clean orphan processes whose parent is confirmed dead
    this.cleanOrphanProcesses();
  }

  /**
   * Safe Orphan Process Cleaner
   * ONLY terminates a process if its owning parent/governor PID is CONFIRMED DEAD.
   * If another live Harness instance owns the process, it is left untouched.
   * Guards against OS PID reuse by validating parent death and executable command signature.
   */
  private async cleanOrphanProcesses(): Promise<void> {
    try {
      if (!fs.existsSync(this.pidRegistryPath)) return;
      const raw = fs.readFileSync(this.pidRegistryPath, 'utf-8');
      const registry: { records: RegisteredPidInfo[] } = JSON.parse(raw);
      const remaining: RegisteredPidInfo[] = [];

      for (const item of registry.records || []) {
        // 1. Check if the parent governor/harness process is still alive
        const parentAlive = await ProcessTree.isAlive(item.parentPid);

        if (parentAlive) {
          // Parent is still alive in another Harness window/session! DO NOT TOUCH.
          remaining.push(item);
          continue;
        }

        // 2. Parent is confirmed dead. Check if child PID is still active
        const childAlive = await ProcessTree.isAlive(item.pid);
        if (childAlive) {
          // 3. Guard against OS PID reuse: verify command signature matches recorded item
          const matchesSignature = await ProcessTree.verifyProcessSignature(item.pid, item.command);
          if (!matchesSignature) {
            console.error(`[host-governor] PID reuse detected for PID ${item.pid} (expected '${item.command}'). Skipping termination.`);
            continue;
          }

          console.error(`[host-governor] Cleaned orphan PID ${item.pid} (${item.command}, abandoned by dead parent ${item.parentPid})`);
          // Attempt graceful first with 1.5s grace period before force
          await ProcessTree.terminate(item.pid, false, 1500);
        }
      }

      // Update registry
      fs.writeFileSync(this.pidRegistryPath, JSON.stringify({ records: remaining }, null, 2), 'utf-8');
    } catch {
      // Non-fatal if registry read/parse fails on startup
    }
  }

  private registerPid(pid: number, command: string, processId: string): void {
    try {
      let records: RegisteredPidInfo[] = [];
      if (fs.existsSync(this.pidRegistryPath)) {
        const raw = fs.readFileSync(this.pidRegistryPath, 'utf-8');
        records = JSON.parse(raw).records || [];
      }
      records = records.filter((r) => r.pid !== pid);
      records.push({
        pid,
        parentPid: process.pid,
        command,
        startTimeMs: Date.now(),
        processId
      });
      fs.writeFileSync(this.pidRegistryPath, JSON.stringify({ records }, null, 2), 'utf-8');
    } catch {}
  }

  private unregisterPid(pid: number): void {
    try {
      if (fs.existsSync(this.pidRegistryPath)) {
        const raw = fs.readFileSync(this.pidRegistryPath, 'utf-8');
        const records = (JSON.parse(raw).records || []).filter((r: RegisteredPidInfo) => r.pid !== pid);
        fs.writeFileSync(this.pidRegistryPath, JSON.stringify({ records }, null, 2), 'utf-8');
      }
    } catch {}
  }

  startProcess(options: ProcessOptions): ManagedProcessRecord {
    const activeCount = Array.from(this.processes.values()).filter((p) => p.state === 'running').length;
    if (activeCount >= this.maxActiveProcesses) {
      throw new Error(`ERR_RESOURCE_LIMIT_EXCEEDED: Active host process limit reached (${activeCount}/${this.maxActiveProcesses}). Terminate running processes before spawning new ones.`);
    }

    const processId = `proc-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const cwdValidation = SecurityGuard.validateWorkingDirectory(options.cwd || process.cwd());
    if (!cwdValidation.valid) {
      throw new Error(`ERR_PATH_RESTRICTED: ${cwdValidation.error}`);
    }
    const cwd = cwdValidation.normalizedPath;
    const args = options.args || [];
    const maxLogLines = options.logBufferSize || 2000;
    const priority = options.priority || 'normal';

    const stateMachine = new ProcessStateMachine('created', 'Process created in supervisor');
    this.stateMachines.set(processId, stateMachine);

    const logBuffer = new BoundedLogBuffer({
      maxLines: maxLogLines,
      headLines: 200,
      spillToFile: options.spillToFile,
      processId
    });
    this.logBuffers.set(processId, logBuffer);

    const record: ManagedProcessRecord = {
      processId,
      command: options.command,
      args,
      cwd,
      tag: options.tag,
      state: 'created',
      status: 'created',
      priority,
      startTime: new Date().toISOString(),
      stateHistory: stateMachine.getHistory(),
      logs: [],
      maxLogLines,
      timeoutMs: options.timeoutMs,
      spillFilePath: logBuffer.spillFilePath
    };

    this.processes.set(processId, record);
    this.totalCreated++;

    // Transition to running
    stateMachine.transition('running', 'Process spawned on host');
    record.state = stateMachine.getState();
    record.status = record.state;
    record.stateHistory = stateMachine.getHistory();

    const isWindows = process.platform === 'win32';
    const useShell = options.allowShell ?? false;

    // Direct argv execution unless shell is explicitly requested
    const child = spawn(options.command, args, {
      cwd,
      shell: useShell ? (isWindows ? 'cmd.exe' : '/bin/sh') : false,
      detached: !isWindows,
      env: {
        ...process.env,
        ...(options.env ? SecurityGuard.redactEnv(options.env) : {}),
        CI: 'true',
        FORCE_COLOR: '0'
      }
    });

    record.pid = child.pid;
    this.processHandles.set(processId, child);

    if (child.pid) {
      this.registerPid(child.pid, options.command, processId);
    }

    logBuffer.append('system', `Process started with PID ${child.pid} [${options.command} ${args.join(' ')}]`);

    // Stream logs
    child.stdout?.on('data', (chunk: Buffer) => {
      logBuffer.append('stdout', chunk.toString());
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      logBuffer.append('stderr', chunk.toString());
    });

    // Execution Timeout guard with graceful escalation
    if (options.timeoutMs && options.timeoutMs > 0) {
      const timer = setTimeout(async () => {
        if (!stateMachine.isTerminal()) {
          logBuffer.append('system', `Execution timeout reached after ${options.timeoutMs}ms. Initiating graceful termination.`);
          stateMachine.transition('timed_out', `Execution exceeded ${options.timeoutMs}ms`);
          record.state = stateMachine.getState();
          record.status = record.state;
          record.stateHistory = stateMachine.getHistory();
          record.endTime = new Date().toISOString();
          this.totalTimedOut++;

          if (child.pid) {
            // Graceful escalation: grace period 1500ms before forced tree kill
            await ProcessTree.terminate(child.pid, false, 1500);
            this.unregisterPid(child.pid);
          }
        }
      }, options.timeoutMs);
      this.executionTimers.set(processId, timer);
    }

    // Process Exit / Close handler
    child.on('close', (code, signal) => {
      this.clearExecutionTimer(processId);
      record.endTime = new Date().toISOString();
      record.exitCode = code;

      if (!stateMachine.isTerminal()) {
        const nextState: ProcessState = code === 0 ? 'completed' : 'failed';
        stateMachine.transition(nextState, `Process closed with code ${code}, signal ${signal}`);
        record.state = stateMachine.getState();
        record.status = record.state;
        record.stateHistory = stateMachine.getHistory();

        if (code === 0) {
          this.totalCompleted++;
        } else {
          this.totalFailed++;
        }
      }

      if (child.pid) {
        this.unregisterPid(child.pid);
      }

      logBuffer.append('system', `Process closed (exitCode: ${code}, signal: ${signal})`);
      this.processHandles.delete(processId);
      logBuffer.close();
    });

    child.on('error', (err) => {
      this.clearExecutionTimer(processId);
      record.endTime = new Date().toISOString();
      if (!stateMachine.isTerminal()) {
        stateMachine.transition('failed', `Spawn error: ${err.message}`);
        record.state = stateMachine.getState();
        record.status = record.state;
        record.stateHistory = stateMachine.getHistory();
        this.totalFailed++;
      }

      if (child.pid) {
        this.unregisterPid(child.pid);
      }

      logBuffer.append('system', `Process error: ${err.message}`);
      this.processHandles.delete(processId);
      logBuffer.close();
    });

    return record;
  }

  getProcess(processId: string): ManagedProcessRecord | undefined {
    const proc = this.processes.get(processId);
    if (!proc) return undefined;

    // Attach latest logs from buffer
    const buf = this.logBuffers.get(processId);
    if (buf) {
      proc.logs = buf.getLogs(100);
    }
    return proc;
  }

  listProcesses(): ManagedProcessRecord[] {
    return Array.from(this.processes.values()).map((p) => {
      const buf = this.logBuffers.get(p.processId);
      return {
        ...p,
        logs: buf ? buf.getLogs(20) : []
      };
    });
  }

  getLogs(processId: string, tail: number = 100, sinceTimestamp?: string): ProcessLogEntry[] {
    const buf = this.logBuffers.get(processId);
    if (!buf) return [];
    return buf.getLogs(tail, sinceTimestamp);
  }

  sendInput(processId: string, text: string): boolean {
    const child = this.processHandles.get(processId);
    const stateMachine = this.stateMachines.get(processId);
    const buf = this.logBuffers.get(processId);

    if (!child || !child.stdin || child.killed || stateMachine?.isTerminal()) {
      return false;
    }

    try {
      child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
      if (buf) {
        buf.append('system', `Input delivered: ${text.trim()}`);
      }
      return true;
    } catch {
      return false;
    }
  }

  async stopProcess(processId: string, force: boolean = false): Promise<boolean> {
    const proc = this.processes.get(processId);
    const child = this.processHandles.get(processId);
    const stateMachine = this.stateMachines.get(processId);
    const buf = this.logBuffers.get(processId);

    this.clearExecutionTimer(processId);

    if (!proc || stateMachine?.isTerminal()) {
      return true;
    }

    stateMachine?.transition('cancelled', `Terminated by user request (force: ${force})`);
    proc.state = stateMachine?.getState() || 'cancelled';
    proc.status = proc.state;
    proc.stateHistory = stateMachine?.getHistory() || [];
    proc.endTime = new Date().toISOString();

    if (child && child.pid) {
      // Respects force flag: when false, attempts graceful termination first with 1500ms grace window
      await ProcessTree.terminate(child.pid, force, 1500);
      this.unregisterPid(child.pid);
    }

    if (buf) {
      buf.append('system', `Process terminated by user request`);
      buf.close();
    }

    this.processHandles.delete(processId);
    return true;
  }

  private clearExecutionTimer(processId: string): void {
    const timer = this.executionTimers.get(processId);
    if (timer) {
      clearTimeout(timer);
      this.executionTimers.delete(processId);
    }
  }

  getMetrics() {
    return {
      totalCreated: this.totalCreated,
      activeProcesses: Array.from(this.processes.values()).filter((p) => p.state === 'running').length,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalTimedOut: this.totalTimedOut
    };
  }
}
