import fs from 'node:fs';
import path from 'node:path';

const SECRET_PATTERNS = [
  /Bearer\s+[a-zA-Z0-9_\-\.]{15,}/gi,
  /ghp_[a-zA-Z0-9]{36}/gi,
  /sk-[a-zA-Z0-9]{20,}/gi,
  /AIza[0-9A-Za-z\-_]{35}/gi,
  /AWS_SECRET_ACCESS_KEY=[a-zA-Z0-9\/+=]{40}/gi,
  /password=["'][^"']+["']/gi,
  /api[_-]?key=["'][a-zA-Z0-9_\-]{16,}["']/gi
];

export class SecurityGuard {
  static redact(text: string): string {
    if (!text) return '';
    let sanitized = text;
    for (const pattern of SECRET_PATTERNS) {
      sanitized = sanitized.replace(pattern, (match) => {
        if (match.startsWith('Bearer ')) return 'Bearer [REDACTED]';
        if (match.startsWith('ghp_')) return 'ghp_[REDACTED]';
        if (match.startsWith('sk-')) return 'sk-[REDACTED]';
        if (match.startsWith('AIza')) return 'AIza[REDACTED]';
        return '[REDACTED_SECRET]';
      });
    }
    return sanitized;
  }

  static redactEnv(env: Record<string, string>): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('key') ||
        lower.includes('secret') ||
        lower.includes('token') ||
        lower.includes('password') ||
        lower.includes('auth')
      ) {
        clean[key] = '[REDACTED]';
      } else {
        clean[key] = value;
      }
    }
    return clean;
  }

  static validateWorkingDirectory(cwd: string): { valid: boolean; normalizedPath: string; error?: string } {
    try {
      const resolved = path.resolve(cwd);
      if (!fs.existsSync(resolved)) {
        return { valid: false, normalizedPath: resolved, error: `Directory does not exist: ${resolved}` };
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { valid: false, normalizedPath: resolved, error: `Path is not a directory: ${resolved}` };
      }

      const allowedRootsEnv = process.env.GOVERNOR_ALLOWED_ROOTS;
      if (allowedRootsEnv && allowedRootsEnv.trim()) {
        const allowedRoots = allowedRootsEnv
          .split(path.delimiter)
          .map((r) => path.resolve(r.trim()))
          .filter(Boolean);
        const isAllowed = allowedRoots.some((root) => {
          const rel = path.relative(root, resolved);
          return !rel.startsWith('..') && !path.isAbsolute(rel);
        });
        if (!isAllowed) {
          return {
            valid: false,
            normalizedPath: resolved,
            error: `Working directory '${resolved}' is outside allowed root directories: ${allowedRoots.join(', ')}`
          };
        }
      }

      return { valid: true, normalizedPath: resolved };
    } catch (err) {
      return { valid: false, normalizedPath: cwd, error: `Invalid path: ${String(err)}` };
    }
  }

  static sanitizeCommand(command: string, args: string[]): { safeCommand: string; safeArgs: string[] } {
    const trimmed = command.trim();
    const cleanArgs = args.map((a) => a.trim());
    return {
      safeCommand: trimmed,
      safeArgs: cleanArgs
    };
  }
}
