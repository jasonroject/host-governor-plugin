import path from 'node:path';
import os from 'node:os';
import { 
  SubAgentLeaseRecord, 
  AcquireSlotParams, 
  AcquireSlotResult, 
  ModelQuotaMetrics, 
  PriorityLevel 
} from './types.js';
import { StateStore } from './state-store.js';

interface QueuedItem {
  requestId: string;
  params: AcquireSlotParams;
  enqueuedAt: number;
  resolve: (res: AcquireSlotResult) => void;
  timer?: NodeJS.Timeout;
}

const PRIORITY_ORDER: Record<PriorityLevel, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1
};

interface SharedGovernorState {
  leases: Record<string, SubAgentLeaseRecord>;
  version: number;
}

export class SubAgentGovernor {
  private readonly defaultMaxSlots: number;
  private readonly instanceId: string;
  private readonly stateStore: StateStore;
  private readonly useSharedState: boolean;

  // Local cache and queues
  private localLeases = new Map<string, SubAgentLeaseRecord>();
  private queues = new Map<string, QueuedItem[]>();
  private idempotencyCache = new Map<string, { leaseId: string; cachedAt: number }>();

  // Metrics
  private totalAcquired: Record<string, number> = {};
  private totalRejected: Record<string, number> = {};
  private totalTimedOut: Record<string, number> = {};
  private totalWaitTimeMs: Record<string, number> = {};

  constructor(options?: { maxSlots?: number; stateFilePath?: string; disableSharedState?: boolean }) {
    const envLimit = process.env.MAX_SUBAGENTS_PER_MODEL ? parseInt(process.env.MAX_SUBAGENTS_PER_MODEL, 10) : NaN;
    this.defaultMaxSlots = options?.maxSlots || (!isNaN(envLimit) && envLimit > 0 ? envLimit : 3);
    this.instanceId = `inst-${process.pid}-${Math.random().toString(36).substring(2, 6)}`;
    this.useSharedState = !options?.disableSharedState;

    const envStateFile = process.env.GOVERNOR_STATE_FILE;
    const baseDir = path.join(os.homedir(), '.gemini', 'antigravity');
    const statePath = options?.stateFilePath || envStateFile || path.join(baseDir, '.governor-state.json');

    this.stateStore = new StateStore({
      filePath: statePath,
      maxRetries: 10,
      retryDelayMs: 15,
      staleLockTimeoutMs: 3000
    });

    // Sweep expired leases every 15s
    setInterval(() => this.reapExpired(), 15000).unref();
  }

  public getMaxSlots(): number {
    return this.defaultMaxSlots;
  }

  public getStateFilePath(): string {
    return this.stateStore.getFilePath();
  }

  async acquireSlot(params: AcquireSlotParams): Promise<AcquireSlotResult> {
    const modelId = params.modelId.trim().toLowerCase();
    const priority = params.priority || 'normal';
    const ttlSeconds = params.leaseTtlSeconds || 600;
    const timeoutMs = params.timeoutMs ?? 0;
    const idempotencyKey = params.idempotencyKey?.trim();

    // 1. Idempotency Check
    if (idempotencyKey) {
      const cached = this.idempotencyCache.get(idempotencyKey);
      if (cached && Date.now() - cached.cachedAt < 60000) {
        const existingLease = this.getLease(cached.leaseId);
        if (existingLease && existingLease.status === 'active') {
          return {
            granted: true,
            leaseId: existingLease.leaseId,
            modelId,
            activeCount: this.getActiveLeaseCount(modelId),
            maxSlots: this.defaultMaxSlots,
            priority: existingLease.priority,
            message: `Idempotent request replayed for sub-agent '${existingLease.subAgentName}'. Existing lease active.`,
            isIdempotentReplay: true
          };
        }
      }
    }

    this.reapExpired();
    const activeCount = this.getActiveLeaseCount(modelId);

    // 2. Immediate Slot Grant if under capacity
    if (activeCount < this.defaultMaxSlots) {
      const lease = this.createLease(modelId, params.subAgentName, priority, ttlSeconds, idempotencyKey);
      this.recordAcquireMetric(modelId, 0);

      if (idempotencyKey) {
        this.idempotencyCache.set(idempotencyKey, { leaseId: lease.leaseId, cachedAt: Date.now() });
      }

      return {
        granted: true,
        leaseId: lease.leaseId,
        modelId,
        activeCount: this.getActiveLeaseCount(modelId),
        maxSlots: this.defaultMaxSlots,
        priority,
        message: `Slot granted for sub-agent '${params.subAgentName}' on model '${modelId}' (${activeCount + 1}/${this.defaultMaxSlots} active).`
      };
    }

    // 3. Capacity Saturated: Handle Non-Blocking Rejection
    if (timeoutMs <= 0) {
      this.totalRejected[modelId] = (this.totalRejected[modelId] || 0) + 1;
      return {
        granted: false,
        modelId,
        activeCount,
        maxSlots: this.defaultMaxSlots,
        priority,
        queued: false,
        message: `Concurrency limit reached: Model '${modelId}' already has ${activeCount}/${this.defaultMaxSlots} active sub-agents. Request rejected.`
      };
    }

    // 4. Queuing with Priority Ordering
    return new Promise<AcquireSlotResult>((resolve) => {
      const requestId = `req-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const enqueuedAt = Date.now();

      const timer = setTimeout(() => {
        this.removeFromQueue(modelId, requestId);
        this.totalTimedOut[modelId] = (this.totalTimedOut[modelId] || 0) + 1;
        resolve({
          granted: false,
          modelId,
          activeCount: this.getActiveLeaseCount(modelId),
          maxSlots: this.defaultMaxSlots,
          priority,
          queued: false,
          waitDurationMs: Date.now() - enqueuedAt,
          message: `Timed out after ${timeoutMs}ms waiting for sub-agent slot on model '${modelId}'.`
        });
      }, timeoutMs);

      const queueItem: QueuedItem = {
        requestId,
        params,
        enqueuedAt,
        resolve,
        timer
      };

      const q = this.getOrCreateQueue(modelId);
      // Insert by priority descending, then FIFO
      const insertIndex = q.findIndex(
        (item) => PRIORITY_ORDER[item.params.priority || 'normal'] < PRIORITY_ORDER[priority]
      );
      if (insertIndex === -1) {
        q.push(queueItem);
      } else {
        q.splice(insertIndex, 0, queueItem);
      }
    });
  }

  releaseSlot(leaseId: string): { released: boolean; modelId?: string; remainingActive: number } {
    let lease = this.localLeases.get(leaseId);
    let modelId = lease?.modelId;

    if (this.useSharedState) {
      this.stateStore.update<SharedGovernorState>({ leases: {}, version: 1 }, (current) => {
        const sharedLease = current.leases[leaseId];
        if (sharedLease && sharedLease.status === 'active') {
          sharedLease.status = 'released';
          modelId = sharedLease.modelId;
        }
        return current;
      });
    }

    if (lease && lease.status === 'active') {
      lease.status = 'released';
      modelId = lease.modelId;
    }

    if (!modelId) {
      return { released: false, remainingActive: 0 };
    }

    const remaining = this.getActiveLeaseCount(modelId);
    this.drainQueue(modelId);

    return {
      released: true,
      modelId,
      remainingActive: remaining
    };
  }

  private drainQueue(modelId: string): void {
    const q = this.queues.get(modelId);
    if (!q || q.length === 0) return;

    const activeCount = this.getActiveLeaseCount(modelId);
    if (activeCount < this.defaultMaxSlots) {
      const next = q.shift();
      if (next) {
        if (next.timer) clearTimeout(next.timer);
        const waitMs = Date.now() - next.enqueuedAt;
        const lease = this.createLease(
          modelId,
          next.params.subAgentName,
          next.params.priority || 'normal',
          next.params.leaseTtlSeconds || 600,
          next.params.idempotencyKey
        );
        this.recordAcquireMetric(modelId, waitMs);

        next.resolve({
          granted: true,
          leaseId: lease.leaseId,
          modelId,
          activeCount: this.getActiveLeaseCount(modelId),
          maxSlots: this.defaultMaxSlots,
          priority: lease.priority,
          waitDurationMs: waitMs,
          message: `Slot granted from queue for sub-agent '${next.params.subAgentName}' on model '${modelId}' after ${waitMs}ms.`
        });
      }
    }
  }

  private createLease(
    modelId: string,
    subAgentName: string,
    priority: PriorityLevel,
    ttlSeconds: number,
    idempotencyKey?: string
  ): SubAgentLeaseRecord {
    const leaseId = `lease-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const now = Date.now();
    const lease: SubAgentLeaseRecord = {
      leaseId,
      modelId,
      subAgentName,
      priority,
      idempotencyKey,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
      status: 'active',
      instanceId: this.instanceId
    };

    this.localLeases.set(leaseId, lease);

    if (this.useSharedState) {
      this.stateStore.update<SharedGovernorState>({ leases: {}, version: 1 }, (current) => {
        current.leases[leaseId] = lease;
        return current;
      });
    }

    return lease;
  }

  private getActiveLeaseCount(modelId: string): number {
    this.reapExpired();
    const now = Date.now();

    if (this.useSharedState) {
      const shared = this.stateStore.read<SharedGovernorState>({ leases: {}, version: 1 });
      return Object.values(shared.leases).filter(
        (l) => l.modelId === modelId && l.status === 'active' && new Date(l.expiresAt).getTime() > now
      ).length;
    }

    return Array.from(this.localLeases.values()).filter(
      (l) => l.modelId === modelId && l.status === 'active' && new Date(l.expiresAt).getTime() > now
    ).length;
  }

  private getLease(leaseId: string): SubAgentLeaseRecord | undefined {
    if (this.useSharedState) {
      const shared = this.stateStore.read<SharedGovernorState>({ leases: {}, version: 1 });
      return shared.leases[leaseId];
    }
    return this.localLeases.get(leaseId);
  }

  private reapExpired(): void {
    const now = Date.now();

    // Reap local
    for (const lease of this.localLeases.values()) {
      if (lease.status === 'active' && new Date(lease.expiresAt).getTime() <= now) {
        lease.status = 'expired';
        this.drainQueue(lease.modelId);
      }
    }

    // Reap shared
    if (this.useSharedState) {
      this.stateStore.update<SharedGovernorState>({ leases: {}, version: 1 }, (current) => {
        let modified = false;
        for (const lease of Object.values(current.leases)) {
          if (lease.status === 'active' && new Date(lease.expiresAt).getTime() <= now) {
            lease.status = 'expired';
            modified = true;
            this.drainQueue(lease.modelId);
          }
        }
        return current;
      });
    }
  }

  private getOrCreateQueue(modelId: string): QueuedItem[] {
    let q = this.queues.get(modelId);
    if (!q) {
      q = [];
      this.queues.set(modelId, q);
    }
    return q;
  }

  private removeFromQueue(modelId: string, requestId: string): void {
    const q = this.queues.get(modelId);
    if (q) {
      this.queues.set(
        modelId,
        q.filter((i) => i.requestId !== requestId)
      );
    }
  }

  private recordAcquireMetric(modelId: string, waitMs: number): void {
    this.totalAcquired[modelId] = (this.totalAcquired[modelId] || 0) + 1;
    this.totalWaitTimeMs[modelId] = (this.totalWaitTimeMs[modelId] || 0) + waitMs;
  }

  getModelMetrics(modelId?: string): ModelQuotaMetrics[] {
    this.reapExpired();
    const models = new Set<string>();

    if (modelId) {
      models.add(modelId.trim().toLowerCase());
    } else {
      if (this.useSharedState) {
        const shared = this.stateStore.read<SharedGovernorState>({ leases: {}, version: 1 });
        for (const l of Object.values(shared.leases)) models.add(l.modelId);
      }
      for (const l of this.localLeases.values()) models.add(l.modelId);
      for (const m of this.queues.keys()) models.add(m);
    }

    if (models.size === 0) models.add('default');

    const result: ModelQuotaMetrics[] = [];
    const now = Date.now();

    for (const m of models) {
      const activeCount = this.getActiveLeaseCount(m);
      const queue = this.queues.get(m) || [];
      const totalAcq = this.totalAcquired[m] || 0;
      const avgWait = totalAcq > 0 ? Math.round((this.totalWaitTimeMs[m] || 0) / totalAcq) : 0;

      let activeList: SubAgentLeaseRecord[] = [];
      if (this.useSharedState) {
        const shared = this.stateStore.read<SharedGovernorState>({ leases: {}, version: 1 });
        activeList = Object.values(shared.leases).filter((l) => l.modelId === m && l.status === 'active');
      } else {
        activeList = Array.from(this.localLeases.values()).filter((l) => l.modelId === m && l.status === 'active');
      }

      result.push({
        modelId: m,
        maxSlots: this.defaultMaxSlots,
        activeSlots: activeCount,
        availableSlots: Math.max(0, this.defaultMaxSlots - activeCount),
        queuedRequests: queue.length,
        totalAcquired: totalAcq,
        totalRejected: this.totalRejected[m] || 0,
        totalTimedOut: this.totalTimedOut[m] || 0,
        avgWaitTimeMs: avgWait,
        activeLeases: activeList.map((l) => ({
          leaseId: l.leaseId,
          subAgentName: l.subAgentName,
          priority: l.priority,
          acquiredAt: l.acquiredAt,
          ageSeconds: Math.round((now - new Date(l.acquiredAt).getTime()) / 1000)
        }))
      });
    }

    return result;
  }
}
