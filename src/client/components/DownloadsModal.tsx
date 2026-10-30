import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  Download,
  Laptop,
  ShieldCheck,
  Smartphone,
  Terminal,
} from "lucide-react";

interface DownloadsModalProps {
  onClose: () => void;
}

interface ArtifactFile {
  name: string;
  size: number;
  url: string;
}

interface DownloadManifest {
  version: string;
  platform: string;
  arch: string;
  githubRelease: string;
  files: ArtifactFile[];
}

interface AssetCard {
  id: string;
  title: string;
  subtitle: string;
  file: string;
  icon: typeof Laptop;
}

const DESKTOP_ASSETS: AssetCard[] = [
  {
    id: "mac-arm",
    title: "macOS",
    subtitle: "Apple silicon (M1–M4)",
    file: "AirBridge-darwin-arm64",
    icon: Laptop,
  },
  {
    id: "mac-x64",
    title: "macOS",
    subtitle: "Intel",
    file: "AirBridge-darwin-x64",
    icon: Laptop,
  },
  {
    id: "win-x64",
    title: "Windows",
    subtitle: "x64 · 10 / 11",
    file: "AirBridge-windows-x64.exe",
    icon: Laptop,
  },
  {
    id: "linux-x64",
    title: "Linux",
    subtitle: "x64 · glibc (static musl in checksums)",
    file: "AirBridge-linux-x64",
    icon: Laptop,
  },
  {
    id: "linux-arm64",
    title: "Linux",
    subtitle: "ARM64",
    file: "AirBridge-linux-arm64",
    icon: Laptop,
  },
  {
    id: "android",
    title: "Android",
    subtitle: "8.0+ · sideload APK, updates install over it",
    file: "AirBridge.apk",
    icon: Smartphone,
  },
];

function recommendId(): string | null {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "cli";
  if (/Windows NT/i.test(ua)) return "win-x64";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac-arm";
  if (/Linux/i.test(ua)) return "linux-x64";
  return null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

const CLI_COMMANDS: Array<{ label: string; cmd: string }> = [
  {
    label: "Run anywhere Node 20+ exists — a pairing QR appears in the terminal",
    cmd: "npx airbridge",
  },
  {
    label: "macOS / Linux installer (no sudo, optional --autostart)",
    cmd: "curl -fsSL https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.sh | bash",
  },
  {
    label: "Windows installer (no admin, no SmartScreen sheet)",
    cmd: 'powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.ps1 -UseBasicParsing | iex"',
  },
];

export function DownloadsModal({ onClose }: DownloadsModalProps) {
  const [manifest, setManifest] = useState<DownloadManifest | null>(null);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const recommended = recommendId();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/downloads")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: DownloadManifest | null) => {
        if (!cancelled && data && Array.isArray(data.files)) setManifest(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const localByName = new Map(manifest?.files.map((f) => [f.name, f]) ?? []);
  const assetUrl = (file: string): string => {
    const local = localByName.get(file);
    if (local) return local.url;
    const base = manifest?.githubRelease ?? "https://github.com/DigantaDey/AirBridge/releases/latest";
    return `${base}/download/${file}`;
  };
  const sumsUrl = localByName.has("SHA256SUMS.txt")
    ? localByName.get("SHA256SUMS.txt")!.url
    : `${manifest?.githubRelease ?? "https://github.com/DigantaDey/AirBridge/releases/latest"}/download/SHA256SUMS.txt`;
  const hasLocalFiles = (manifest?.files.length ?? 0) > 0;

  const copyCmd = (cmd: string, idx: number) => {
    navigator.clipboard?.writeText(cmd).catch(() => {});
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1600);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="downloads-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-3xl ab-elevated shadow-2xl p-6 border border-white/15 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-sky-400">
              Download AirBridge
            </span>
            <h2 id="downloads-title" className="text-lg font-semibold text-[var(--ab-text)] mt-0.5">
              Pick your platform
              {manifest?.version && manifest.version !== "dev" ? ` · v${manifest.version}` : ""}
            </h2>
            <p className="text-xs text-[var(--ab-muted)] mt-1 max-w-xl leading-relaxed">
              Single-file builds — no accounts, no paid signatures.{" "}
              {hasLocalFiles
                ? "Files available on this computer are served straight from it over your local network (no internet needed)."
                : "Downloads come from the project's GitHub Releases."}{" "}
              Every release ships <code className="font-mono">SHA256SUMS.txt</code> for verification.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--ab-muted)] hover:text-[var(--ab-text)] text-xl leading-none cursor-pointer"
          >
            ×
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {DESKTOP_ASSETS.map((card) => {
            const Icon = card.icon;
            const local = localByName.get(card.file);
            const isRecommended = recommended === card.id;
            return (
              <div
                key={card.id}
                className={`rounded-2xl border p-4 space-y-2 ${
                  isRecommended
                    ? "border-sky-400/50 bg-sky-400/[0.06]"
                    : "border-[var(--ab-border)] bg-black/[0.03] dark:bg-white/[0.03]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ab-text)]">
                    <Icon className="w-4 h-4 text-sky-400" />
                    <span>
                      {card.title}
                      <span className="text-[var(--ab-muted)] font-normal"> · {card.subtitle}</span>
                    </span>
                  </div>
                  {isRecommended && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-sky-400/15 text-sky-400 border border-sky-400/30">
                      This device
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-[var(--ab-muted)]">
                    {local ? `On this computer · ${formatSize(local.size)}` : "From GitHub Releases"}
                  </span>
                  <a
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/35 hover:bg-emerald-500/25 no-underline cursor-pointer"
                    href={assetUrl(card.file)}
                    download
                  >
                    <Download className="w-3.5 h-3.5" />
                    Download
                  </a>
                </div>
              </div>
            );
          })}
        </div>

        {/* Universal CLI card — any platform with Node, QR in the terminal */}
        <div className="rounded-2xl border border-[var(--ab-border)] bg-black/[0.03] dark:bg-white/[0.03] p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ab-text)]">
              <Terminal className="w-4 h-4 text-emerald-400" />
              <span>
                Any other platform
                <span className="text-[var(--ab-muted)] font-normal">
                  {" "}· FreeBSD, RISC-V, old NAS boxes, …
                </span>
              </span>
            </div>
            {recommended === "cli" && (
              <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-sky-400/15 text-sky-400 border border-sky-400/30">
                This device
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--ab-text-secondary)] leading-relaxed">
            AirBridge is truly cross-platform: anywhere a Node 20+ runtime (or the{" "}
            <code className="font-mono">npx airbridge</code> shim) can start, the server starts —
            and it prints a <strong>pairing QR in the terminal</strong> so a phone connects by
            scanning. iPhone/iPad: use Safari on this page (Add to Home Screen for a full-screen app).
          </p>
          <div className="space-y-2.5">
            {CLI_COMMANDS.map((item, idx) => (
              <div key={idx} className="space-y-1">
                <p className="text-[11px] text-[var(--ab-muted)]">{item.label}</p>
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-950 text-slate-200 border border-white/10 font-mono text-xs">
                  <div className="flex items-center gap-2 truncate">
                    <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="truncate">{item.cmd}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyCmd(item.cmd, idx)}
                    aria-label="Copy command"
                    className="p-1 text-slate-400 hover:text-white shrink-0 cursor-pointer"
                  >
                    {copiedIdx === idx ? (
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Security footer */}
        <div className="flex items-start gap-2 text-[11px] text-[var(--ab-muted)] leading-relaxed border-t border-[var(--ab-border)] pt-3">
          <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <p>
            Verify downloads against{" "}
            <a className="text-sky-400 no-underline" href={sumsUrl}>
              SHA256SUMS.txt
            </a>
            . macOS binaries are ad-hoc signed by CI (no Gatekeeper fee); the Windows installer uses
            curl so the EXE carries no Mark-of-the-Web (no SmartScreen sheet); Android APKs are
            signed with a stable sideload key so updates install over the previous version. Pairing
            codes are short-lived session secrets — rotate from the Pair panel after sharing.
          </p>
        </div>
      </div>
    </div>
  );
}
