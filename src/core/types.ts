export type GovernorErrorCode =
  | 'ERR_PROCESS_NOT_FOUND'
  | 'ERR_CONCURRENCY_LIMIT_REACHED'
  | 'ERR_RESOURCE_LIMIT_EXCEEDED'
  | 'ERR_INVALID_CWD'
  | 'ERR_EXECUTION_TIMEOUT'
  | 'ERR_INVALID_TRANSITION'
  | 'ERR_SPAWN_FAILED';

export interface StructuredGovernorError {
  code: GovernorErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type ProcessState = 
  | 'created' 
  | 'queued' 
  | 'running' 
  | 'completed' 
  | 'failed' 
  | 'cancelled' 
  | 'timed_out';

export type PriorityLevel = 'low' | 'normal' | 'high' | 'critical';

export interface StateTransition {
  from: ProcessState;
  to: ProcessState;
  timestamp: string;
  reason?: string;
}

export interface ProcessLogEntry {
  timestamp: string;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
}

export interface ProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  tag?: string;
  timeoutMs?: number;
  priority?: PriorityLevel;
  logBufferSize?: number;
  allowShell?: boolean;
  spillToFile?: boolean;
}

export interface ManagedProcessRecord {
  processId: string;
  pid?: number;
  command: string;
  args: string[];
  cwd: string;
  tag?: string;
  state: ProcessState;
  status: ProcessState; // Backward-compatible alias for state
  priority: PriorityLevel;
  startTime: string;
  endTime?: string;
  exitCode?: number | null;
  stateHistory: StateTransition[];
  logs: ProcessLogEntry[];
  maxLogLines: number;
  timeoutMs?: number;
  spillFilePath?: string;
}

export interface SubAgentLeaseRecord {
  leaseId: string;
  modelId: string;
  subAgentName: string;
  priority: PriorityLevel;
  idempotencyKey?: string;
  acquiredAt: string;
  expiresAt: string;
  status: 'active' | 'released' | 'expired';
  instanceId: string;
}

export interface AcquireSlotParams {
  modelId: string;
  subAgentName: string;
  priority?: PriorityLevel;
  idempotencyKey?: string;
  leaseTtlSeconds?: number;
  timeoutMs?: number;
}

export interface AcquireSlotResult {
  granted: boolean;
  leaseId?: string;
  modelId: string;
  activeCount: number;
  maxSlots: number;
  priority: PriorityLevel;
  message: string;
  queued?: boolean;
  queuePosition?: number;
  waitDurationMs?: number;
  isIdempotentReplay?: boolean;
}

export interface ModelQuotaMetrics {
  modelId: string;
  maxSlots: number;
  activeSlots: number;
  availableSlots: number;
  queuedRequests: number;
  totalAcquired: number;
  totalRejected: number;
  totalTimedOut: number;
  avgWaitTimeMs: number;
  activeLeases: {
    leaseId: string;
    subAgentName: string;
    priority: PriorityLevel;
    acquiredAt: string;
    ageSeconds: number;
  }[];
}

export interface GovernorStatusReport {
  timestamp: string;
  policy: {
    maxSubAgentsPerModel: number;
    crossInstanceShared: boolean;
    storagePath?: string;
  };
  metrics: {
    totalProcessesTracked: number;
    activeProcesses: number;
    completedProcesses: number;
    failedProcesses: number;
    timedOutProcesses: number;
  };
  models: ModelQuotaMetrics[];
  activeProcesses: {
    processId: string;
    pid?: number;
    command: string;
    state: ProcessState;
    uptimeSeconds: number;
    tag?: string;
  }[];
}
