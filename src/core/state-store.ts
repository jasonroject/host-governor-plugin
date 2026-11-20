import fs from 'node:fs';
import path from 'node:path';

export interface StateStoreOptions {
  filePath: string;
  maxRetries?: number;
  retryDelayMs?: number;
  staleLockTimeoutMs?: number;
}

/**
 * StateStore
 * Provides atomic, thread-safe, and process-safe local state persistence.
 * Specifically handles Windows EPERM / EBUSY contention when multiple agent
 * instances read and write state concurrently.
 */
export class StateStore {
  private readonly filePath: string;
  private readonly lockFilePath: string;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly staleLockTimeoutMs: number;

  constructor(options: StateStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.lockFilePath = `${this.filePath}.lock`;
    this.maxRetries = options.maxRetries ?? 8;
    this.retryDelayMs = options.retryDelayMs ?? 15;
    this.staleLockTimeoutMs = options.staleLockTimeoutMs ?? 4000;
  }

  getFilePath(): string {
    return this.filePath;
  }

  private sleepSync(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // synchronous tight busy-wait for sub-millisecond to small millisecond durations
    }
  }

  acquireLock(timeoutMs: number = 2000): boolean {
    const startTime = Date.now();
    const pid = process.pid;

    while (Date.now() - startTime < timeoutMs) {
      try {
        const dir = path.dirname(this.lockFilePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // 'wx' flag: Open for writing, fails if path exists (atomic create)
        const fd = fs.openSync(this.lockFilePath, 'wx');
        fs.writeFileSync(fd, JSON.stringify({ pid, time: Date.now() }), 'utf-8');
        fs.closeSync(fd);
        return true;
      } catch (err: any) {
        if (err.code === 'EEXIST' || err.code === 'EPERM' || err.code === 'EBUSY') {
          // Check for stale lock
          this.cleanStaleLock();
          // Jittered backoff (10ms - 25ms)
          const jitter = this.retryDelayMs + Math.floor(Math.random() * 15);
          this.sleepSync(jitter);
        } else {
          return false;
        }
      }
    }
    return false;
  }

  releaseLock(): void {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        fs.unlinkSync(this.lockFilePath);
      }
    } catch {
      // ignore unlink error
    }
  }

  private cleanStaleLock(): void {
    try {
      if (fs.existsSync(this.lockFilePath)) {
        const stat = fs.statSync(this.lockFilePath);
        const age = Date.now() - stat.mtimeMs;
        if (age > this.staleLockTimeoutMs) {
          fs.unlinkSync(this.lockFilePath);
        }
      }
    } catch {
      // ignore
    }
  }

  read<T>(fallback: T): T {
    let attempts = 0;
    while (attempts < this.maxRetries) {
      try {
        if (!fs.existsSync(this.filePath)) {
          return fallback;
        }
        const content = fs.readFileSync(this.filePath, 'utf-8');
        if (!content.trim()) return fallback;
        return JSON.parse(content) as T;
      } catch (err: any) {
        if (err.code === 'EBUSY' || err.code === 'EPERM' || err instanceof SyntaxError) {
          attempts++;
          const jitter = this.retryDelayMs + Math.floor(Math.random() * 15);
          this.sleepSync(jitter);
        } else {
          return fallback;
        }
      }
    }
    return fallback;
  }

  write<T>(data: T): boolean {
    const dir = path.dirname(this.filePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    } catch {
      // directory might have been created concurrently
    }

    const tempFile = `${this.filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
    const payload = JSON.stringify(data, null, 2);

    // 1. Write to unique temp file
    try {
      fs.writeFileSync(tempFile, payload, 'utf-8');
    } catch (err: any) {
      return false;
    }

    // 2. Atomic rename with Windows EPERM / EBUSY retry loop
    let attempts = 0;
    while (attempts < this.maxRetries) {
      try {
        fs.renameSync(tempFile, this.filePath);
        return true;
      } catch (err: any) {
        if (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') {
          attempts++;
          const jitter = this.retryDelayMs + Math.floor(Math.random() * 20);
          this.sleepSync(jitter);
        } else {
          // If rename is unsupported across drives or fails permanently, attempt copy + unlink
          try {
            fs.copyFileSync(tempFile, this.filePath);
            fs.unlinkSync(tempFile);
            return true;
          } catch {
            return false;
          }
        }
      }
    }

    // Fallback: try copyFileSync
    try {
      fs.copyFileSync(tempFile, this.filePath);
      fs.unlinkSync(tempFile);
      return true;
    } catch {
      try {
        fs.unlinkSync(tempFile);
      } catch {}
      return false;
    }
  }

  update<T>(fallback: T, modifier: (current: T) => T): T {
    const locked = this.acquireLock(1500);
    try {
      const current = this.read<T>(fallback);
      const updated = modifier(current);
      this.write<T>(updated);
      return updated;
    } finally {
      if (locked) {
        this.releaseLock();
      }
    }
  }
}
