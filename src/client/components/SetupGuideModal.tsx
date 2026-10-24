import { useState } from 'react';
import { Check, Copy, Laptop, Shield, Smartphone, Terminal, X } from 'lucide-react';

interface SetupGuideModalProps {
  open: boolean;
  onClose: () => void;
}

export function SetupGuideModal({ open, onClose }: SetupGuideModalProps) {
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);

  if (!open) return null;

  const copyCmd = (cmd: string, idx: number) => {
    navigator.clipboard?.writeText(cmd).catch(() => {});
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1600);
  };

  const cliCommands = [
    {
      title: 'Start MacBook Auto-Save Daemon (saves directly to ~/Downloads + macOS notifications)',
      cmd: 'npx airbridge daemon',
    },
    {
      title: 'Instant CLI Beam from MacBook Terminal to Android (prints terminal QR code)',
      cmd: 'npx airbridge send ./Presentation.pdf ./Demo-4K.mp4',
    },
  ];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/65 backdrop-blur-md"
    >
      <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-3xl ab-elevated shadow-2xl p-6 border border-white/15 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-sky-400">
              Native Ecosystem Integration
            </span>
            <h3 className="text-lg font-semibold text-[var(--ab-text)] mt-0.5">
              Android Share Sheet, macOS CLI & Warp Architecture
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl text-[var(--ab-muted)] hover:text-[var(--ab-text)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 1. Android Native Share Sheet */}
        <div className="rounded-2xl bg-black/[0.04] dark:bg-white/[0.03] border border-[var(--ab-border)] p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
            <Smartphone className="w-4 h-4" />
            <span>1. Add to Android Native Share Sheet (Zero APK Sideloading)</span>
          </div>
          <p className="text-xs text-[var(--ab-text-secondary)] leading-relaxed">
            Open AirBridge in Chrome on Android and tap{' '}
            <strong className="text-[var(--ab-text)]">Menu (⋮) → Install App</strong>. AirBridge
            registers a native Web Share Target Level 2 handler — whenever you tap{' '}
            <strong className="text-[var(--ab-text)]">Share</strong> in Google Photos, Gallery, or
            Files, <strong className="text-[var(--ab-text)]">AirBridge</strong> appears right in the
            Android system Share Sheet and beams original uncompressed files straight to your MacBook.
          </p>
        </div>

        {/* 2. macOS Native CLI & Auto-Save Daemon */}
        <div className="rounded-2xl bg-black/[0.04] dark:bg-white/[0.03] border border-[var(--ab-border)] p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-sky-400">
            <Laptop className="w-4 h-4" />
            <span>2. MacBook Terminal CLI & Direct ~/Downloads Daemon</span>
          </div>
          <p className="text-xs text-[var(--ab-text-secondary)] leading-relaxed">
            Run AirBridge locally on your MacBook over offline Wi-Fi/Hotspot with mDNS Bonjour (
            <code className="font-mono-tabular text-sky-400">_airbridge._tcp.local</code>), native
            macOS Notification Center alerts, and automatic saving into{' '}
            <code className="font-mono-tabular">~/Downloads/AirBridge</code>:
          </p>

          <div className="space-y-2.5">
            {cliCommands.map((item, idx) => (
              <div key={idx} className="space-y-1">
                <p className="text-[11px] text-[var(--ab-muted)]">{item.title}</p>
                <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-slate-950 text-slate-200 border border-white/10 font-mono-tabular text-xs">
                  <div className="flex items-center gap-2 truncate">
                    <Terminal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="truncate">{item.cmd}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyCmd(item.cmd, idx)}
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

        {/* 3. Cryptographic & Transport Specs */}
        <div className="rounded-2xl bg-black/[0.04] dark:bg-white/[0.03] border border-[var(--ab-border)] p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ab-text)]">
            <Shield className="w-4 h-4 text-emerald-400" />
            <span>3. Zero-Knowledge Security & Dual-Transport Engine</span>
          </div>
          <ul className="text-xs text-[var(--ab-text-secondary)] space-y-1.5 list-disc pl-4">
            <li>
              <strong>Ephemeral ECDH P-256 + HKDF-SHA256 + AES-256-GCM:</strong> Keys are generated
              in WebCrypto memory per session with matching 6-digit SAS verification codes.
            </li>
            <li>
              <strong>Hybrid WebRTC P2P + Binary WSS Relay:</strong> Streams directly peer-to-peer
              over LAN UDP/SCTP when reachable, and seamlessly falls back to raw binary encrypted
              WebSocket frames (with sliding-window backpressure) across strict NATs or 5G cellular.
            </li>
            <li>
              <strong>End-to-End SHA-256 Integrity:</strong> Every transferred file is cryptographically
              hashed and verified chunk-by-chunk upon arrival.
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
