import { spawn } from 'node:child_process';

export interface HostClipboardProvider {
  isSupported: () => boolean;
  readText: () => Promise<string | null>;
  writeText: (text: string) => Promise<boolean>;
}

const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KB cap for background clipboard reads
const CMD_TIMEOUT_MS = 1_500;

function normalizeClipboardComparison(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function runClipboardRead(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ ok: boolean; text: string | null; missingBinary?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let totalBytes = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];

    const finish = (res: { ok: boolean; text: string | null; missingBinary?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    let child;
    try {
      child = spawn(cmd, args, {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish({ ok: false, text: null, missingBinary: true });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({ ok: false, text: null });
    }, CMD_TIMEOUT_MS);
    timer.unref();

    child.stdout.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > DEFAULT_MAX_BYTES) {
        overflowed = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        return;
      }
      chunks.push(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: false, text: null, missingBinary: err.code === 'ENOENT' });
    });

    child.on('close', (code) => {
      if (overflowed) {
        finish({ ok: false, text: null });
        return;
      }
      if (code === 0) {
        finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
      } else {
        finish({ ok: false, text: null });
      }
    });
  });
}

function runClipboardWrite(
  cmd: string,
  args: string[],
  text: string,
  env: NodeJS.ProcessEnv
): Promise<{ ok: boolean; missingBinary?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res: { ok: boolean; missingBinary?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    let child;
    try {
      child = spawn(cmd, args, {
        env,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      finish({ ok: false, missingBinary: true });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({ ok: false });
    }, CMD_TIMEOUT_MS);
    timer.unref();

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: false, missingBinary: err.code === 'ENOENT' });
    });

    child.on('close', (code) => {
      finish({ ok: code === 0 });
    });

    child.stdin.on('error', () => {
      // Ignore EPIPE if process exits early
    });
    child.stdin.end(Buffer.from(text, 'utf8'));
  });
}

export function createSystemClipboardProvider(
  platform: NodeJS.Platform = process.platform
): HostClipboardProvider {
  const utf8Env: NodeJS.ProcessEnv = {
    ...process.env,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
  };

  if (platform === 'darwin') {
    let available = true;
    return {
      isSupported: () => available,
      async readText() {
        if (!available) return null;
        const res = await runClipboardRead('pbpaste', [], utf8Env);
        if (res.missingBinary) available = false;
        return res.ok ? res.text : null;
      },
      async writeText(text: string) {
        if (!available) return false;
        const res = await runClipboardWrite('pbcopy', [], text, utf8Env);
        if (res.missingBinary) available = false;
        return res.ok;
      },
    };
  }

  if (platform === 'win32') {
    let available = true;
    return {
      isSupported: () => available,
      async readText() {
        if (!available) return null;
        const res = await runClipboardRead(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
          utf8Env
        );
        if (res.missingBinary) available = false;
        return res.ok ? res.text : null;
      },
      async writeText(text: string) {
        if (!available) return false;
        const res = await runClipboardWrite(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard'],
          text,
          utf8Env
        );
        if (res.missingBinary) available = false;
        return res.ok;
      },
    };
  }

  if (platform === 'linux') {
    const hasWayland = Boolean(process.env.WAYLAND_DISPLAY);
    const hasX11 = Boolean(process.env.DISPLAY);
    let backend: 'wayland' | 'xclip' | 'xsel' | 'none' = hasWayland
      ? 'wayland'
      : hasX11
        ? 'xclip'
        : 'none';

    return {
      isSupported: () => backend !== 'none',
      async readText() {
        if (backend === 'none') return null;
        if (backend === 'wayland') {
          const res = await runClipboardRead(
            'wl-paste',
            ['--no-newline', '--type', 'text/plain'],
            utf8Env
          );
          if (res.missingBinary) {
            backend = hasX11 ? 'xclip' : 'none';
          } else {
            return res.ok ? res.text : '';
          }
        }
        if (backend === 'xclip') {
          const res = await runClipboardRead(
            'xclip',
            ['-selection', 'clipboard', '-o'],
            utf8Env
          );
          if (res.missingBinary) {
            backend = 'xsel';
          } else {
            return res.ok ? res.text : '';
          }
        }
        if (backend === 'xsel') {
          const res = await runClipboardRead(
            'xsel',
            ['--clipboard', '--output'],
            utf8Env
          );
          if (res.missingBinary) {
            backend = 'none';
            return null;
          }
          return res.ok ? res.text : '';
        }
        return null;
      },
      async writeText(text: string) {
        if (backend === 'none') return false;
        if (backend === 'wayland') {
          const res = await runClipboardWrite('wl-copy', [], text, utf8Env);
          if (!res.missingBinary) return res.ok;
          backend = hasX11 ? 'xclip' : 'none';
        }
        if (backend === 'xclip') {
          const res = await runClipboardWrite(
            'xclip',
            ['-selection', 'clipboard', '-i'],
            text,
            utf8Env
          );
          if (!res.missingBinary) return res.ok;
          backend = 'xsel';
        }
        if (backend === 'xsel') {
          const res = await runClipboardWrite(
            'xsel',
            ['--clipboard', '--input'],
            text,
            utf8Env
          );
          if (res.missingBinary) backend = 'none';
          return res.ok;
        }
        return false;
      },
    };
  }

  return {
    isSupported: () => false,
    async readText() {
      return null;
    },
    async writeText() {
      return false;
    },
  };
}

export interface HostClipboardMonitorOptions {
  provider: HostClipboardProvider;
  pollIntervalMs?: number;
  maxTextLength?: number;
  onClipboardChange: (text: string) => void;
}

export class HostClipboardMonitor {
  private readonly provider: HostClipboardProvider;
  private readonly pollIntervalMs: number;
  private readonly maxTextLength: number;
  private readonly onClipboardChange: (text: string) => void;

  private shouldWatch = false;
  private closed = false;
  private seeded = false;
  private pollingInFlight = false;
  private lastNormalized = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: HostClipboardMonitorOptions) {
    this.provider = opts.provider;
    this.pollIntervalMs = opts.pollIntervalMs ?? 650;
    this.maxTextLength = opts.maxTextLength ?? 256_000;
    this.onClipboardChange = opts.onClipboardChange;
  }

  public isSupported(): boolean {
    return this.provider.isSupported();
  }

  public setShouldWatch(active: boolean): void {
    if (this.closed) return;
    if (active === this.shouldWatch) return;
    this.shouldWatch = active;

    if (!active) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.seeded = false;
      return;
    }

    if (this.provider.isSupported()) {
      this.schedulePoll(0);
    }
  }

  public async writeClipboard(text: string): Promise<boolean> {
    if (this.closed || !this.provider.isSupported()) return false;
    const normalized = normalizeClipboardComparison(text);
    this.lastNormalized = normalized;
    this.seeded = true;
    return this.provider.writeText(text);
  }

  public close(): void {
    this.closed = true;
    this.shouldWatch = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.closed || !this.shouldWatch || !this.provider.isSupported()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.pollOnce().catch(() => {});
    }, delayMs);
    this.timer.unref();
  }

  private async pollOnce(): Promise<void> {
    if (this.closed || !this.shouldWatch || this.pollingInFlight) return;
    this.pollingInFlight = true;
    try {
      const current = await this.provider.readText();
      if (this.closed || !this.shouldWatch) return;

      if (current !== null) {
        const normalized = normalizeClipboardComparison(current);
        if (!this.seeded) {
          this.lastNormalized = normalized;
          this.seeded = true;
        } else if (
          normalized.length > 0 &&
          current.length <= this.maxTextLength &&
          normalized !== this.lastNormalized
        ) {
          this.lastNormalized = normalized;
          this.onClipboardChange(current.trim());
        }
      }
    } finally {
      this.pollingInFlight = false;
      if (!this.closed && this.shouldWatch && this.provider.isSupported()) {
        this.schedulePoll(this.pollIntervalMs);
      }
    }
  }
}
