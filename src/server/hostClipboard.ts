import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { isValidClipboardImageDataUrl, MAX_CLIPBOARD_IMAGE_DATAURL } from '../shared/protocol.js';

export type HostClipboardContent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; imageDataUrl: string; imageName?: string };

export interface HostClipboardProvider {
  isSupported: () => boolean;
  readText: () => Promise<string | null>;
  writeText: (text: string) => Promise<boolean>;
  readClipboard?: () => Promise<HostClipboardContent | null>;
  writeImage?: (imageDataUrl: string) => Promise<boolean>;
  close?: () => void;
}

export interface HostClipboardTelemetry {
  supported: boolean;
  running: boolean;
  textCaptures: number;
  imageCaptures: number;
  textWrites: number;
  imageWrites: number;
  suppressedEchoes: number;
  corruptedTextBlocked: number;
  errors: number;
  lastError: string | null;
}

const DEFAULT_MAX_BYTES = 512 * 1024; // 512 KB cap for background text clipboard reads
const IMAGE_CMD_MAX_BYTES = MAX_CLIPBOARD_IMAGE_DATAURL + 256 * 1024;
const CMD_TIMEOUT_MS = 1_500;
const IMAGE_CMD_TIMEOUT_MS = 4_000;

const DARWIN_IMAGE_PASTEBOARD_TYPES = new Set([
  'public.png',
  'public.jpeg',
  'public.jpg',
  'public.tiff',
  'public.heic',
  'public.heif',
  'com.compuserve.gif',
  'org.webmproject.webp',
  'com.microsoft.bmp',
  'apple png pasteboard type',
  'next tiff v4.0 pasteboard type',
  'public.image',
]);

const DARWIN_TEXT_PASTEBOARD_TYPES = new Set([
  'public.utf8-plain-text',
  'public.utf16-plain-text',
  'public.plain-text',
  'nsstringpboardtype',
]);

/**
 * Classifies macOS NSPasteboard types so an image or Finder image file copy is
 * always captured as an image even if filename/metadata text UTIs are also present.
 */
export function classifyMacPasteboardTypes(
  types: readonly string[],
  hasImageFileUrl = false,
): 'image' | 'text' | 'none' {
  if (hasImageFileUrl) return 'image';
  const normalized = types.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  for (const t of normalized) {
    if (DARWIN_IMAGE_PASTEBOARD_TYPES.has(t)) return 'image';
  }
  for (const t of normalized) {
    if (DARWIN_TEXT_PASTEBOARD_TYPES.has(t)) return 'text';
  }
  return 'none';
}

/**
 * Rejects raw binary bytes or corrupted decode artifacts (NULs, high U+FFFD or
 * control-char density, PNG/JPEG/TIFF/WebP/PDF/bplist magic headers) so image
 * pasteboard payloads are never beamed to Android as random gibberish text.
 */
export function isCorruptedBinaryClipboardText(text: string): boolean {
  if (!text) return false;
  if (text.includes('\u0000')) return true;
  if (
    /^(?:\u0089PNG|\ufffdPNG|GIF8[79]a|%PDF-|bplist00)/.test(text) ||
    /^RIFF[\s\S]{0,8}WEBP/.test(text) ||
    text.startsWith('\ufffd\ufffd\ufffd\ufffd')
  ) {
    return true;
  }
  let controlCount = 0;
  let replacementCount = 0;
  const sampleLen = Math.min(text.length, 4096);
  for (let i = 0; i < sampleLen; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0xfffd) {
      replacementCount += 1;
    } else if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) {
      controlCount += 1;
    }
  }
  if (replacementCount >= 3 && replacementCount / sampleLen > 0.08) return true;
  if (controlCount >= 3 && controlCount / sampleLen > 0.04) return true;
  return false;
}

export type ClipboardCommandRunner = (
  cmd: string,
  args: string[],
  stdinText: string | null,
  env: NodeJS.ProcessEnv,
  maxBytes?: number,
  timeoutMs?: number,
) => Promise<{ ok: boolean; stdout: string | null; missingBinary?: boolean }>;

function normalizeClipboardComparison(text: string): string {
  return text.replace(/\r\n/g, '\n');
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

    let child: ReturnType<typeof spawn>;
    const finish = (res: { ok: boolean; text: string | null; missingBinary?: boolean }, timer?: NodeJS.Timeout) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };

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
      finish({ ok: false, text: null }, timer);
    }, CMD_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
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
      finish({ ok: false, text: null, missingBinary: err.code === 'ENOENT' }, timer);
    });

    child.on('close', (code) => {
      if (overflowed) {
        finish({ ok: false, text: null }, timer);
        return;
      }
      if (code === 0) {
        finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }, timer);
      } else {
        finish({ ok: false, text: null }, timer);
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
    let child: ReturnType<typeof spawn>;
    const finish = (res: { ok: boolean; missingBinary?: boolean }, timer?: NodeJS.Timeout) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };

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
      finish({ ok: false }, timer);
    }, CMD_TIMEOUT_MS);
    timer.unref();

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ ok: false, missingBinary: err.code === 'ENOENT' }, timer);
    });

    child.on('close', (code) => {
      finish({ ok: code === 0 }, timer);
    });

    child.stdin?.on('error', () => {
      // Ignore EPIPE if process exits early
    });
    child.stdin?.end(Buffer.from(text, 'utf8'));
  });
}

function runClipboardCommand(
  cmd: string,
  args: string[],
  stdinText: string | null,
  env: NodeJS.ProcessEnv,
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = CMD_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string | null; missingBinary?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let totalBytes = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];

    let child: ReturnType<typeof spawn>;
    const finish = (res: { ok: boolean; stdout: string | null; missingBinary?: boolean }, timer?: NodeJS.Timeout) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(res);
    };

    try {
      child = spawn(cmd, args, {
        env,
        stdio: [stdinText !== null ? 'pipe' : 'ignore', 'pipe', 'ignore'],
      });
    } catch {
      finish({ ok: false, stdout: null, missingBinary: true });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish({ ok: false, stdout: null }, timer);
    }, timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
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
      finish({ ok: false, stdout: null, missingBinary: err.code === 'ENOENT' }, timer);
    });

    child.on('close', (code) => {
      if (overflowed) {
        finish({ ok: false, stdout: null }, timer);
        return;
      }
      if (code === 0) {
        finish({ ok: true, stdout: Buffer.concat(chunks).toString('utf8') }, timer);
      } else {
        finish({ ok: false, stdout: null }, timer);
      }
    });

    if (stdinText !== null) {
      child.stdin?.on('error', () => {
        // Ignore EPIPE if process exits early
      });
      child.stdin?.end(Buffer.from(stdinText, 'utf8'));
    }
  });
}

const DARWIN_READ_JXA = `
ObjC.import('AppKit');
ObjC.import('Foundation');
(() => {
  const pb = $.NSPasteboard.generalPasteboard;
  const typesArr = [];
  const pbTypes = pb.types;
  if (pbTypes) {
    const count = pbTypes.count;
    for (let i = 0; i < count; i++) typesArr.push(ObjC.unwrap(pbTypes.objectAtIndex(i)));
  }
  const exts = /\\.(png|jpe?g|webp|gif|heic|heif|tiff?|bmp)$/i;
  let imageUrl = null;
  let imageName = null;
  try {
    const url = $.NSURL.URLFromPasteboard(pb);
    if (url && ObjC.unwrap(url.isFileURL)) {
      const pathStr = ObjC.unwrap(url.path);
      if (pathStr && exts.test(pathStr)) {
        imageUrl = url;
        imageName = ObjC.unwrap(url.lastPathComponent);
      }
    }
  } catch (e) {}
  const lower = typesArr.map((t) => String(t).toLowerCase());
  const isImageType = Boolean(imageUrl) || lower.some((t) =>
    t === 'public.png' || t === 'public.jpeg' || t === 'public.jpg' || t === 'public.tiff' ||
    t === 'public.heic' || t === 'public.heif' || t === 'com.compuserve.gif' ||
    t === 'org.webmproject.webp' || t === 'com.microsoft.bmp' ||
    t === 'apple png pasteboard type' || t === 'next tiff v4.0 pasteboard type' || t === 'public.image'
  );
  if (!isImageType) {
    return JSON.stringify({ kind: 'other', types: typesArr });
  }
  const encodeRep = (data, mime) => {
    if (!data || data.length === 0 || data.length > 5000000) return null;
    const b64 = ObjC.unwrap(data.base64EncodedStringWithOptions(0));
    if (!b64) return null;
    const dataUrl = 'data:' + mime + ';base64,' + b64;
    if (dataUrl.length > ${MAX_CLIPBOARD_IMAGE_DATAURL}) return null;
    return JSON.stringify({ kind: 'image', imageDataUrl: dataUrl, imageName: imageName || 'clipboard-image.' + mime.split('/')[1] });
  };
  if (!imageUrl) {
    const directPng = pb.dataForType($.NSPasteboardTypePNG) || pb.dataForType($('public.png'));
    const directPngOut = encodeRep(directPng, 'image/png');
    if (directPngOut) return directPngOut;
    const directJpg = pb.dataForType($('public.jpeg'));
    const directJpgOut = encodeRep(directJpg, 'image/jpeg');
    if (directJpgOut) return directJpgOut;
  }
  const img = imageUrl ? $.NSImage.alloc.initWithContentsOfURL(imageUrl) : $.NSImage.alloc.initWithPasteboard(pb);
  if (!img) return JSON.stringify({ kind: 'other', types: typesArr });
  const tiff = img.TIFFRepresentation;
  if (!tiff) return JSON.stringify({ kind: 'other', types: typesArr });
  const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (!rep) return JSON.stringify({ kind: 'other', types: typesArr });
  const props = $.NSMutableDictionary.dictionary;
  const pngData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, props);
  const pngOut = encodeRep(pngData, 'image/png');
  if (pngOut) return pngOut;
  props.setObjectForKey($(0.85), $.NSImageCompressionFactor);
  const jpgData = rep.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, props);
  const jpgOut = encodeRep(jpgData, 'image/jpeg');
  if (jpgOut) return jpgOut;
  return JSON.stringify({ kind: 'none' });
})();
`;

const DARWIN_WRITE_IMAGE_JXA = `
ObjC.import('AppKit');
ObjC.import('Foundation');
(() => {
  const inData = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  const inStr = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(inData, $.NSUTF8StringEncoding));
  const parsed = JSON.parse(inStr);
  const rawData = $.NSData.alloc.initWithBase64EncodedStringOptions($(parsed.b64), 0);
  if (!rawData || rawData.length === 0) return 'ERR';
  const img = $.NSImage.alloc.initWithData(rawData);
  if (!img) return 'ERR';
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const ok = pb.writeObjects($([img]));
  if (parsed.mime === 'image/png') {
    pb.setDataForType(rawData, $.NSPasteboardTypePNG);
  }
  return ok ? 'OK' : 'ERR';
})();
`;

export function createSystemClipboardProvider(
  platform: NodeJS.Platform = process.platform,
  runner: ClipboardCommandRunner = runClipboardCommand,
): HostClipboardProvider {
  const utf8Env: NodeJS.ProcessEnv = {
    ...process.env,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
  };

  if (platform === 'darwin') {
    let available = true;
    const readTextOnly = async (): Promise<string | null> => {
      const res = await runClipboardRead('pbpaste', [], utf8Env);
      if (res.missingBinary) available = false;
      if (!res.ok || res.text === null) return null;
      return isCorruptedBinaryClipboardText(res.text) ? null : res.text;
    };
    return {
      isSupported: () => available,
      async readText() {
        if (!available) return null;
        return readTextOnly();
      },
      async writeText(text: string) {
        if (!available) return false;
        const res = await runClipboardWrite('pbcopy', [], text, utf8Env);
        if (res.missingBinary) available = false;
        return res.ok;
      },
      async readClipboard() {
        if (!available) return null;
        const jxa = await runner(
          'osascript',
          ['-l', 'JavaScript', '-e', DARWIN_READ_JXA],
          null,
          utf8Env,
          IMAGE_CMD_MAX_BYTES,
          IMAGE_CMD_TIMEOUT_MS,
        );
        if (jxa.ok && jxa.stdout) {
          try {
            const parsed = JSON.parse(jxa.stdout.trim()) as {
              kind?: string;
              imageDataUrl?: string;
              imageName?: string;
              types?: string[];
            };
            if (
              parsed.kind === 'image' &&
              typeof parsed.imageDataUrl === 'string' &&
              isValidClipboardImageDataUrl(parsed.imageDataUrl)
            ) {
              return {
                kind: 'image',
                imageDataUrl: parsed.imageDataUrl,
                imageName: typeof parsed.imageName === 'string' ? parsed.imageName : undefined,
              };
            }
            if (parsed.kind === 'none') return null;
            if (parsed.kind === 'other' && Array.isArray(parsed.types)) {
              const kind = classifyMacPasteboardTypes(parsed.types, false);
              if (kind !== 'text') return null;
            }
          } catch {
            // Fall through to sanitized text check
          }
        }
        const text = await readTextOnly();
        return text !== null ? { kind: 'text', text } : null;
      },
      async writeImage(imageDataUrl: string) {
        if (!available || !isValidClipboardImageDataUrl(imageDataUrl)) return false;
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(imageDataUrl.trim());
        if (!match) return false;
        const payload = JSON.stringify({ mime: match[1].toLowerCase(), b64: match[2] });
        const res = await runner(
          'osascript',
          ['-l', 'JavaScript', '-e', DARWIN_WRITE_IMAGE_JXA],
          payload,
          utf8Env,
          64 * 1024,
          IMAGE_CMD_TIMEOUT_MS,
        );
        return res.ok && (res.stdout ?? '').trim() === 'OK';
      },
    };
  }

  if (platform === 'win32') {
    let available = true;
    let worker: ReturnType<typeof spawn> | null = null;
    let stdoutBuf = '';
    const queue: Array<(line: string | null) => void> = [];
    const WORKER_SCRIPT = [
      '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'while (($line = [Console]::In.ReadLine()) -ne $null) {',
      '  if ($line -eq "R") {',
      '    try {',
      '      $v = Get-Clipboard -Raw -ErrorAction Stop',
      '      if ($null -eq $v) { [Console]::Out.WriteLine("OK:") }',
      '      else {',
      '        $b = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$v))',
      '        [Console]::Out.WriteLine("OK:" + $b)',
      '      }',
      '    } catch { [Console]::Out.WriteLine("ERR") }',
      '  } elseif ($line.StartsWith("W:")) {',
      '    try {',
      '      $s = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring(2)))',
      '      Set-Clipboard -Value $s -ErrorAction Stop',
      '      [Console]::Out.WriteLine("OK")',
      '    } catch { [Console]::Out.WriteLine("ERR") }',
      '  }',
      '}',
    ].join('; ');

    const stopWorker = () => {
      const w = worker;
      worker = null;
      stdoutBuf = '';
      while (queue.length > 0) queue.shift()?.(null);
      if (w) {
        try { w.kill(); } catch { /* ignore */ }
      }
    };

    const ensureWorker = (): ReturnType<typeof spawn> | null => {
      if (!available) return null;
      if (worker && !worker.killed && worker.exitCode === null) return worker;
      try {
        const child = spawn(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', WORKER_SCRIPT],
          { env: utf8Env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true },
        );
        worker = child;
        stdoutBuf = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8');
          for (;;) {
            const nl = stdoutBuf.indexOf('\n');
            if (nl < 0) break;
            const line = stdoutBuf.slice(0, nl).replace(/\r$/, '');
            stdoutBuf = stdoutBuf.slice(nl + 1);
            queue.shift()?.(line);
          }
        });
        child.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') available = false;
          stopWorker();
        });
        child.on('close', () => {
          if (worker === child) stopWorker();
        });
        return child;
      } catch {
        available = false;
        return null;
      }
    };

    const sendWorkerCommand = (commandLine: string): Promise<string | null> =>
      new Promise((resolve) => {
        const w = ensureWorker();
        if (!w || !w.stdin) {
          resolve(null);
          return;
        }
        let done = false;
        const onReply = (line: string | null) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(line);
        };
        const timer = setTimeout(() => {
          const idx = queue.indexOf(onReply);
          if (idx >= 0) queue.splice(idx, 1);
          stopWorker();
          onReply(null);
        }, CMD_TIMEOUT_MS);
        timer.unref();
        queue.push(onReply);
        try {
          w.stdin.write(`${commandLine}\n`);
        } catch {
          const idx = queue.indexOf(onReply);
          if (idx >= 0) queue.splice(idx, 1);
          stopWorker();
          onReply(null);
        }
      });

    return {
      isSupported: () => available,
      async readText() {
        if (!available) return null;
        const reply = await sendWorkerCommand('R');
        if (reply && reply.startsWith('OK:')) {
          const b64 = reply.slice(3);
          if (!b64) return '';
          const buf = Buffer.from(b64, 'base64');
          return buf.byteLength <= DEFAULT_MAX_BYTES ? buf.toString('utf8') : null;
        }
        return null;
      },
      async writeText(text: string) {
        if (!available) return false;
        const b64 = Buffer.from(text, 'utf8').toString('base64');
        const reply = await sendWorkerCommand(`W:${b64}`);
        return reply === 'OK';
      },
      close() {
        stopWorker();
      },
    };
  }

  if (platform === 'linux') {
    let backend: 'wayland' | 'xclip' | 'xsel' | 'none' = 'none';
    let lastWaylandDisplay = '';
    let lastX11Display = '';
    const refreshLinuxBackend = () => {
      const wayland = process.env.WAYLAND_DISPLAY || '';
      const x11 = process.env.DISPLAY || '';
      if (backend === 'none' || wayland !== lastWaylandDisplay || x11 !== lastX11Display) {
        lastWaylandDisplay = wayland;
        lastX11Display = x11;
        if (wayland) backend = 'wayland';
        else if (x11) backend = 'xclip';
        else backend = 'none';
      }
    };
    refreshLinuxBackend();

    return {
      isSupported: () => {
        refreshLinuxBackend();
        return backend !== 'none';
      },
      async readText() {
        refreshLinuxBackend();
        if (backend === 'none') return null;
        const runtimeEnv: NodeJS.ProcessEnv = {
          ...utf8Env,
          ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
          ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        };
        if (backend === 'wayland') {
          const res = await runClipboardRead(
            'wl-paste',
            ['--no-newline', '--type', 'text/plain'],
            runtimeEnv
          );
          if (res.missingBinary) {
            backend = process.env.DISPLAY ? 'xclip' : 'none';
          } else {
            return res.ok ? res.text : '';
          }
        }
        if (backend === 'xclip') {
          const res = await runClipboardRead(
            'xclip',
            ['-selection', 'clipboard', '-o'],
            runtimeEnv
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
            runtimeEnv
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
        refreshLinuxBackend();
        if (backend === 'none') return false;
        const runtimeEnv: NodeJS.ProcessEnv = {
          ...utf8Env,
          ...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
          ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
        };
        if (backend === 'wayland') {
          const res = await runClipboardWrite('wl-copy', [], text, runtimeEnv);
          if (!res.missingBinary) return res.ok;
          backend = process.env.DISPLAY ? 'xclip' : 'none';
        }
        if (backend === 'xclip') {
          const res = await runClipboardWrite(
            'xclip',
            ['-selection', 'clipboard', '-i'],
            text,
            runtimeEnv
          );
          if (!res.missingBinary) return res.ok;
          backend = 'xsel';
        }
        if (backend === 'xsel') {
          const res = await runClipboardWrite(
            'xsel',
            ['--clipboard', '--input'],
            text,
            runtimeEnv
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
  onClipboardImageChange?: (imageDataUrl: string, imageName?: string) => void;
}

export class HostClipboardMonitor {
  private readonly provider: HostClipboardProvider;
  private readonly pollIntervalMs: number;
  private readonly maxTextLength: number;
  private readonly onClipboardChange: (text: string) => void;
  private readonly onClipboardImageChange?: (imageDataUrl: string, imageName?: string) => void;

  private shouldWatch = false;
  private closed = false;
  private seeded = false;
  private pollingInFlight = false;
  private lastNormalized = '';
  private lastSnapshotKey = '';
  private timer: NodeJS.Timeout | null = null;
  private writing = false;
  private writeRevision = 0;
  private lastWrittenNormalized: string | null = null;
  private lastWrittenImageHash: string | null = null;
  private lastWrittenAt = 0;
  private pendingWrite:
    | { kind: 'text'; text: string; resolve: (written: boolean) => void }
    | { kind: 'image'; imageDataUrl: string; hash: string; resolve: (written: boolean) => void }
    | null = null;
  private textCaptures = 0;
  private imageCaptures = 0;
  private textWrites = 0;
  private imageWrites = 0;
  private suppressedEchoes = 0;
  private corruptedTextBlocked = 0;
  private errors = 0;
  private lastError: string | null = null;

  constructor(opts: HostClipboardMonitorOptions) {
    this.provider = opts.provider;
    this.pollIntervalMs = opts.pollIntervalMs ?? 650;
    this.maxTextLength = opts.maxTextLength ?? 256_000;
    this.onClipboardChange = opts.onClipboardChange;
    this.onClipboardImageChange = opts.onClipboardImageChange;
  }

  public isSupported(): boolean {
    return this.provider.isSupported();
  }

  public getTelemetry(): HostClipboardTelemetry {
    return {
      supported: this.provider.isSupported(),
      running: !this.closed && this.shouldWatch && this.provider.isSupported(),
      textCaptures: this.textCaptures,
      imageCaptures: this.imageCaptures,
      textWrites: this.textWrites,
      imageWrites: this.imageWrites,
      suppressedEchoes: this.suppressedEchoes,
      corruptedTextBlocked: this.corruptedTextBlocked,
      errors: this.errors,
      lastError: this.lastError,
    };
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

  public writeClipboard(text: string): Promise<boolean> {
    if (this.closed || !this.provider.isSupported() || text.length > this.maxTextLength) return Promise.resolve(false);
    const normalized = normalizeClipboardComparison(text);
    if (normalized && normalized === this.lastWrittenNormalized && Date.now() - this.lastWrittenAt < 2_000) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.pendingWrite?.resolve(false); // a superseded clipboard value is not an OS write
      this.pendingWrite = { kind: 'text', text, resolve };
      void this.flushWrites();
    });
  }

  public writeImage(imageDataUrl: string): Promise<boolean> {
    if (
      this.closed ||
      !this.provider.isSupported() ||
      !this.provider.writeImage ||
      !isValidClipboardImageDataUrl(imageDataUrl)
    ) {
      return Promise.resolve(false);
    }
    const hash = crypto.createHash('sha256').update(imageDataUrl).digest('hex');
    if (hash === this.lastWrittenImageHash && Date.now() - this.lastWrittenAt < 4_000) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this.pendingWrite?.resolve(false);
      this.pendingWrite = { kind: 'image', imageDataUrl, hash, resolve };
      void this.flushWrites();
    });
  }

  private async flushWrites(): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      while (this.pendingWrite && !this.closed) {
        const write = this.pendingWrite;
        this.pendingWrite = null;
        this.writeRevision++;
        let written = false;
        if (write.kind === 'text') {
          try {
            written = await this.provider.writeText(write.text);
          } catch (err) {
            this.errors += 1;
            this.lastError = err instanceof Error ? err.message : String(err);
          }
          if (written) {
            const normalized = normalizeClipboardComparison(write.text);
            this.lastNormalized = normalized;
            this.lastWrittenNormalized = normalized;
            this.lastSnapshotKey = `text:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
            this.lastWrittenAt = Date.now();
            this.seeded = true;
            this.textWrites += 1;
          }
        } else {
          try {
            written = (await this.provider.writeImage?.(write.imageDataUrl)) ?? false;
          } catch (err) {
            this.errors += 1;
            this.lastError = err instanceof Error ? err.message : String(err);
          }
          if (written) {
            this.lastWrittenImageHash = write.hash;
            this.lastSnapshotKey = `image:${write.hash}`;
            this.lastWrittenAt = Date.now();
            this.seeded = true;
            this.imageWrites += 1;
          }
        }
        write.resolve(written);
      }
    } finally { this.writing = false; }
  }

  public close(): void {
    this.closed = true;
    this.shouldWatch = false;
    this.pendingWrite?.resolve(false);
    this.pendingWrite = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.provider.close?.();
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
      if (this.writing) return;
      const revision = this.writeRevision;
      let content: HostClipboardContent | null = null;
      if (this.provider.readClipboard) {
        content = await this.provider.readClipboard();
      } else {
        const text = await this.provider.readText();
        if (text !== null) content = { kind: 'text', text };
      }
      if (this.closed || !this.shouldWatch || this.writing || revision !== this.writeRevision) return;

      if (!content) return;

      if (content.kind === 'image') {
        if (!isValidClipboardImageDataUrl(content.imageDataUrl)) return;
        const hash = crypto.createHash('sha256').update(content.imageDataUrl).digest('hex');
        const key = `image:${hash}`;
        if (!this.seeded) {
          this.lastSnapshotKey = key;
          this.seeded = true;
          return;
        }
        if (hash === this.lastWrittenImageHash && Date.now() - this.lastWrittenAt < 4_000) {
          this.suppressedEchoes += 1;
          this.lastSnapshotKey = key;
          return;
        }
        if (key !== this.lastSnapshotKey) {
          this.lastSnapshotKey = key;
          this.imageCaptures += 1;
          this.onClipboardImageChange?.(content.imageDataUrl, content.imageName);
        }
        return;
      }

      if (isCorruptedBinaryClipboardText(content.text)) {
        this.corruptedTextBlocked += 1;
        return;
      }
      const normalized = normalizeClipboardComparison(content.text);
      const key = `text:${crypto.createHash('sha256').update(normalized).digest('hex')}`;
      if (!this.seeded) {
        this.lastNormalized = normalized;
        this.lastSnapshotKey = key;
        this.seeded = true;
      } else if (normalized !== this.lastNormalized || key !== this.lastSnapshotKey) {
        if (normalized === this.lastWrittenNormalized && Date.now() - this.lastWrittenAt < 4_000) {
          this.suppressedEchoes += 1;
          this.lastNormalized = normalized;
          this.lastSnapshotKey = key;
          return;
        }
        this.lastNormalized = normalized;
        this.lastSnapshotKey = key;
        if (normalized.trim().length > 0 && content.text.length <= this.maxTextLength) {
          this.textCaptures += 1;
          this.onClipboardChange(content.text);
        }
      }
    } catch (err) {
      this.errors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
    } finally {
      this.pollingInFlight = false;
      if (!this.closed && this.shouldWatch && this.provider.isSupported()) {
        this.schedulePoll(this.pollIntervalMs);
      }
    }
  }
}
