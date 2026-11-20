import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);

export class ProcessTree {
  static async terminate(pid: number, force: boolean = false, gracePeriodMs: number = 1500): Promise<{ success: boolean; method: string }> {
    const isWindows = process.platform === 'win32';

    if (isWindows) {
      // Windows taskkill /T kills child tree, /F forces kill
      try {
        if (!force) {
          // Attempt graceful first
          try {
            await execAsync(`taskkill /pid ${pid} /t`);
            // Check if still alive after short wait
            await new Promise((r) => setTimeout(r, Math.min(gracePeriodMs, 1000)));
            if (!(await ProcessTree.isAlive(pid))) {
              return { success: true, method: 'windows-graceful-taskkill' };
            }
          } catch {
            // ignore and escalate
          }
        }
        // Force kill tree
        await execAsync(`taskkill /pid ${pid} /t /f`);
        return { success: true, method: 'windows-force-taskkill' };
      } catch (err) {
        // Fallback to process.kill
        try {
          process.kill(pid, 'SIGKILL');
          return { success: true, method: 'node-sigkill-fallback' };
        } catch {
          return { success: false, method: 'failed' };
        }
      }
    } else {
      // POSIX process group
      try {
        if (!force) {
          try {
            process.kill(-pid, 'SIGTERM');
            await new Promise((r) => setTimeout(r, gracePeriodMs));
            if (!(await ProcessTree.isAlive(pid))) {
              return { success: true, method: 'posix-group-sigterm' };
            }
          } catch {
            // try single pid if group fails
            process.kill(pid, 'SIGTERM');
          }
        }
        // Escalate to SIGKILL
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          process.kill(pid, 'SIGKILL');
        }
        return { success: true, method: 'posix-sigkill' };
      } catch (err) {
        return { success: false, method: 'failed' };
      }
    }
  }

  static async isAlive(pid: number): Promise<boolean> {
    try {
      // Sending signal 0 checks if process exists without killing it
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e.code === 'EPERM'; // Exists but no permission means it is alive
    }
  }

  /**
   * Guards against OS PID reuse.
   * Verifies that the running process with the specified PID matches the expected executable name.
   */
  static async verifyProcessSignature(pid: number, expectedCommand: string): Promise<boolean> {
    const isWindows = process.platform === 'win32';
    const baseExpected = path.basename(expectedCommand).toLowerCase().replace(/\.exe$/, '');

    try {
      if (isWindows) {
        const { stdout } = await execAsync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`);
        if (stdout.includes('INFO: No tasks')) return false;
        const match = stdout.match(/"([^"]+)"/);
        if (!match) return false;
        const runningImage = match[1].toLowerCase().replace(/\.exe$/, '');
        return runningImage.includes(baseExpected) || baseExpected.includes(runningImage);
      } else {
        const { stdout } = await execAsync(`ps -p ${pid} -o comm=`);
        const comm = stdout.trim().toLowerCase();
        return comm.includes(baseExpected) || baseExpected.includes(comm);
      }
    } catch {
      return false;
    }
  }
}
