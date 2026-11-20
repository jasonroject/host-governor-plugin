import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ProcessLogEntry } from './types.js';
import { SecurityGuard } from './security-guard.js';

export interface BoundedBufferOptions {
  maxLines?: number;
  headLines?: number;
  spillToFile?: boolean;
  processId: string;
}

export class BoundedLogBuffer {
  private headLogs: ProcessLogEntry[] = [];
  private tailLogs: ProcessLogEntry[] = [];
  private totalLineCount: number = 0;
  private readonly maxLines: number;
  private readonly headLimit: number;
  private spillStream?: fs.WriteStream;
  public readonly spillFilePath?: string;

  constructor(options: BoundedBufferOptions) {
    this.maxLines = options.maxLines || 2000;
    this.headLimit = options.headLines || 200;

    if (options.spillToFile) {
      const tmpDir = os.tmpdir();
      this.spillFilePath = path.join(tmpDir, `host-gov-log-${options.processId}.log`);
      this.spillStream = fs.createWriteStream(this.spillFilePath, { flags: 'a', encoding: 'utf-8' });
    }
  }

  append(stream: 'stdout' | 'stderr' | 'system', rawText: string): void {
    const timestamp = new Date().toISOString();
    const redactedText = SecurityGuard.redact(rawText);
    const entry: ProcessLogEntry = { timestamp, stream, text: redactedText };

    this.totalLineCount++;

    // Write to disk spool if enabled
    if (this.spillStream) {
      this.spillStream.write(`[${timestamp}] [${stream}] ${redactedText}\n`);
    }

    // Keep head logs (e.g. first 200 lines: configuration, startup messages)
    if (this.headLogs.length < this.headLimit) {
      this.headLogs.push(entry);
      return;
    }

    // Otherwise maintain tail ring buffer
    this.tailLogs.push(entry);
    const tailCapacity = this.maxLines - this.headLimit;
    if (this.tailLogs.length > tailCapacity) {
      this.tailLogs.shift();
    }
  }

  getLogs(tailCount?: number, sinceTimestamp?: string): ProcessLogEntry[] {
    let combined = [...this.headLogs, ...this.tailLogs];

    if (sinceTimestamp) {
      const sinceMs = new Date(sinceTimestamp).getTime();
      combined = combined.filter((l) => new Date(l.timestamp).getTime() > sinceMs);
    }

    if (tailCount && tailCount > 0) {
      return combined.slice(-tailCount);
    }

    return combined;
  }

  getTotalLines(): number {
    return this.totalLineCount;
  }

  close(): void {
    if (this.spillStream) {
      this.spillStream.end();
    }
  }
}
