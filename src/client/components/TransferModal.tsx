import { useState } from 'react';
import { Check, FileText, Lock, ShieldCheck, X } from 'lucide-react';
import { formatBytes } from '../../shared/protocol.js';
import type { TransferSessionView } from '../engine/warpClient.js';
import { DeviceHardwareIcon } from './DeviceIcons.js';

interface TransferModalProps {
  offer: TransferSessionView | null;
  senderPublicKey?: string;
  onAccept: (transferId: string, trustSender: boolean) => void;
  onDecline: (transferId: string) => void;
}

export function TransferModal({
  offer,
  senderPublicKey,
  onAccept,
  onDecline,
}: TransferModalProps) {
  const [trustAlways, setTrustAlways] = useState(false);

  if (!offer || offer.direction !== 'incoming' || offer.status !== 'pending-accept') {
    return null;
  }

  const previews = offer.files.filter((f) => Boolean(f.previewDataUrl));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="airbridge-offer-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md"
    >
      <div className="w-full max-w-md rounded-3xl ab-elevated shadow-2xl p-6 border border-white/15 animate-in fade-in zoom-in-95 duration-150">
        {/* Sender Header */}
        <div className="flex items-center gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center justify-center shrink-0">
            <DeviceHardwareIcon platform={offer.peerPlatform} className="w-7 h-7" />
          </div>
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-400">
              <Lock className="w-3 h-3" />
              AirBridge Encrypted Drop
            </span>
            <h3 id="airbridge-offer-title" className="text-base font-semibold text-[var(--ab-text)] truncate">
              {offer.peerName} wants to share
            </h3>
            <p className="text-xs text-[var(--ab-muted)] font-mono-tabular">
              {offer.files.length} file{offer.files.length > 1 ? 's' : ''} ·{' '}
              {formatBytes(offer.totalBytes)} · 🔐 {offer.sasCode}
            </p>
          </div>
        </div>

        {/* Live Encrypted Image Thumbnail Previews (Just like Apple AirDrop!) */}
        {previews.length > 0 && (
          <div className="mt-4 grid grid-cols-3 gap-2">
            {previews.slice(0, 3).map((p) => (
              <div
                key={p.index}
                className="aspect-square rounded-2xl overflow-hidden border border-white/10 bg-black/20"
              >
                <img
                  src={p.previewDataUrl}
                  alt={p.name}
                  className="w-full h-full object-cover"
                />
              </div>
            ))}
          </div>
        )}

        {/* File Manifest List */}
        <div className="mt-4 max-h-40 overflow-y-auto space-y-1.5 rounded-2xl bg-black/[0.04] dark:bg-white/[0.04] p-3 border border-[var(--ab-border)]">
          {offer.files.map((f) => (
            <div key={f.index} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span className="truncate text-[var(--ab-text)]">{f.relativePath || f.name}</span>
              </div>
              <span className="text-[11px] font-mono-tabular text-[var(--ab-muted)] shrink-0">
                {formatBytes(f.size)}
              </span>
            </div>
          ))}
        </div>

        {/* Trust Device Auto-Accept Option */}
        {senderPublicKey && (
          <label className="mt-4 flex items-center gap-2.5 text-xs text-[var(--ab-text-secondary)] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={trustAlways}
              onChange={(e) => setTrustAlways(e.target.checked)}
              className="rounded border-slate-600 text-emerald-500 focus:ring-emerald-500"
            />
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>Auto-accept future drops from {offer.peerName}</span>
          </label>
        )}

        {/* Decline / Accept Buttons */}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => onDecline(offer.transferId)}
            className="py-2.5 px-4 rounded-2xl text-sm font-semibold bg-black/[0.05] dark:bg-white/[0.06] hover:bg-rose-500/15 hover:text-rose-400 text-[var(--ab-text)] inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
            Decline
          </button>
          <button
            type="button"
            onClick={() => onAccept(offer.transferId, trustAlways)}
            className="py-2.5 px-4 rounded-2xl text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 inline-flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/20 transition-colors cursor-pointer"
          >
            <Check className="w-4 h-4" />
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
