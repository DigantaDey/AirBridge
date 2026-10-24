import { useState } from 'react';
import { Clipboard, Lock, Send, X } from 'lucide-react';
import type { PeerSummary } from '../../shared/protocol.js';

interface ClipboardModalProps {
  peer: PeerSummary | null;
  sasCode?: string;
  onClose: () => void;
  onSendClipboard: (peerId: string, text: string) => Promise<void>;
}

export function ClipboardModal({
  peer,
  sasCode,
  onClose,
  onSendClipboard,
}: ClipboardModalProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  if (!peer) return null;

  const handlePasteFromSystem = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setText(clip);
    } catch {
      // Browser requires user permission or manual Cmd+V
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setSending(true);
    try {
      await onSendClipboard(peer.peerId, text);
      setText('');
      onClose();
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md"
    >
      <div className="w-full max-w-lg rounded-3xl ab-elevated shadow-2xl p-6 border border-white/15">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-sky-400">
              <Lock className="w-3 h-3" />
              Universal Encrypted Clipboard · 🔐 {sasCode ?? '··· ···'}
            </span>
            <h3 className="text-base font-semibold text-[var(--ab-text)] mt-0.5">
              Beam Text, Link, or OTP to {peer.device.name}
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

        <form onSubmit={handleSubmit} className="mt-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--ab-muted)]">
              Paste URL, 2FA OTP code, Wi-Fi password, or code snippet:
            </span>
            <button
              type="button"
              onClick={handlePasteFromSystem}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-sky-500/15 text-sky-400 hover:bg-sky-500/25 cursor-pointer"
            >
              <Clipboard className="w-3.5 h-3.5" />
              Paste System Clipboard
            </button>
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            autoFocus
            placeholder="https://... or 849201 or terminal command..."
            className="w-full rounded-2xl p-3.5 text-xs font-mono-tabular bg-black/[0.04] dark:bg-white/[0.04] border border-[var(--ab-border)] text-[var(--ab-text)] placeholder:text-[var(--ab-muted)] focus:outline-none focus:ring-2 focus:ring-sky-500"
          />

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-[var(--ab-muted)] hover:text-[var(--ab-text)] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!text.trim() || sending}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 transition-colors cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              {sending ? 'Beaming…' : 'Beam Instantly'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
