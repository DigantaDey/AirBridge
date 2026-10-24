import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileText,
  Image as ImageIcon,
  KeyRound,
  Send,
  Smartphone,
  Upload,
  Wifi,
  X,
} from 'lucide-react';
import { formatBytes, formatSpeed } from '../../shared/protocol.js';
import {
  WarpClient,
  type SendableFileInput,
  type WarpClientSnapshot,
  wrapBrowserFile,
} from '../engine/warpClient.js';
import { triggerSingleFileDownload } from '../engine/fileDropUtils.js';

interface CompanionSimulatorProps {
  open: boolean;
  hostPairCode: string;
  hostPeerId: string;
  onClose: () => void;
}

async function generateSampleAndroidPhoto(): Promise<SendableFileInput> {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 960;
  const ctx = canvas.getContext('2d')!;

  // Rich twilight gradient shot ("Pixel 9 Pro Night Sight")
  const grad = ctx.createLinearGradient(0, 0, 1280, 960);
  grad.addColorStop(0, '#091529');
  grad.addColorStop(0.5, '#0f3952');
  grad.addColorStop(1, '#10b981');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1280, 960);

  // Geometric sun/moon & horizon waves
  ctx.fillStyle = 'rgba(253, 224, 71, 0.88)';
  ctx.beginPath();
  ctx.arc(920, 280, 110, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = 'rgba(8, 15, 30, 0.72)';
  ctx.beginPath();
  ctx.moveTo(0, 680);
  ctx.quadraticCurveTo(380, 560, 720, 660);
  ctx.quadraticCurveTo(1040, 740, 1280, 610);
  ctx.lineTo(1280, 960);
  ctx.lineTo(0, 960);
  ctx.closePath();
  ctx.fill();

  // EXIF-style crisp overlay stamp
  ctx.fillStyle = '#F8FAFC';
  ctx.font = 'bold 42px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('Shot on Pixel 9 Pro · AirBridge E2EE', 64, 830);
  ctx.fillStyle = 'rgba(248, 250, 252, 0.75)';
  ctx.font = '26px ui-monospace, SFMono-Regular, monospace';
  ctx.fillText(`RAW UNCOMPRESSED · ${new Date().toISOString()}`, 64, 880);

  const blob: Blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b || new Blob(['sample'])), 'image/png')
  );
  const file = new File([blob], 'PXL_20261024_NIGHTSIGHT.png', { type: 'image/png' });
  return wrapBrowserFile(file);
}

function generateSamplePdfDoc(): SendableFileInput {
  const streamText = [
    'BT',
    '/F1 18 Tf',
    '54 730 Td',
    '(AirBridge: Android <-> MacBook E2EE PDF Transfer) Tj',
    '/F1 11 Tf',
    '0 -28 Td',
    '(Transferred seamlessly over Warp Protocol v1 with SHA-256 verification.) Tj',
    '0 -20 Td',
    '(Encryption: Ephemeral ECDH P-256 + HKDF-SHA256 + AES-256-GCM) Tj',
    '0 -20 Td',
    '(Zero cloud servers. Zero file size compression. 100% Open Source.) Tj',
    'ET',
  ].join('\n');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${streamText.length} >>\nstream\n${streamText}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }

  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  const file = new File([pdf], 'AirBridge-Architecture-Spec.pdf', { type: 'application/pdf' });
  return wrapBrowserFile(file);
}

export function CompanionSimulator({
  open,
  hostPairCode,
  hostPeerId,
  onClose,
}: CompanionSimulatorProps) {
  const clientRef = useRef<WarpClient | null>(null);
  const filePickerRef = useRef<HTMLInputElement | null>(null);
  const [snap, setSnap] = useState<WarpClientSnapshot | null>(null);
  const [clipDraft, setClipDraft] = useState('492817');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !hostPairCode) return;

    const simClient = new WarpClient({
      initialPairCode: hostPairCode,
      storagePrefix: 'airbridge-sim-pixel',
      deviceOverride: {
        name: 'Pixel 9 Pro · Virtual',
        platform: 'android',
        model: 'Pixel 9 Pro',
        formFactor: 'phone',
      },
    });

    clientRef.current = simClient;
    const unsub = simClient.subscribe((next) => setSnap(next));
    simClient.start();

    return () => {
      unsub();
      simClient.stop();
      clientRef.current = null;
    };
  }, [open, hostPairCode]);

  if (!open) return null;

  const targetMacPeer =
    snap?.peers.find((p) => p.peerId === hostPeerId) ?? snap?.peers[0] ?? null;

  const pendingOffer =
    snap?.transfers.find((t) => t.direction === 'incoming' && t.status === 'pending-accept') ??
    null;

  const sendSamplePhoto = async () => {
    if (!clientRef.current || !targetMacPeer) return;
    const photo = await generateSampleAndroidPhoto();
    await clientRef.current.sendFiles(targetMacPeer.peerId, [photo]);
  };

  const sendSamplePdf = async () => {
    if (!clientRef.current || !targetMacPeer) return;
    const doc = generateSamplePdfDoc();
    await clientRef.current.sendFiles(targetMacPeer.peerId, [doc]);
  };

  const sendSimClipboard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientRef.current || !targetMacPeer || !clipDraft.trim()) return;
    await clientRef.current.sendClipboard(targetMacPeer.peerId, clipDraft.trim());
  };

  return (
    <div className="rounded-[2.2rem] bg-slate-950 text-slate-100 border-[3px] border-slate-800 shadow-2xl p-4 flex flex-col justify-between min-h-[540px] max-w-[360px] w-full mx-auto relative overflow-hidden">
      {/* Android 15 Punch-hole & Status Bar */}
      <div>
        <div className="flex items-center justify-between text-[11px] text-slate-400 px-2 pb-3">
          <span className="font-mono-tabular font-medium">Android 15</span>
          <div className="w-3 h-3 rounded-full bg-slate-900 border border-slate-700" />
          <div className="flex items-center gap-2">
            <Wifi className="w-3.5 h-3.5 text-emerald-400" />
            <button
              type="button"
              onClick={onClose}
              title="Disconnect Virtual Pixel 9 Pro"
              className="p-0.5 rounded-md hover:bg-white/10 text-slate-400 hover:text-white cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Phone Header Card */}
        <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/25 p-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0">
              <Smartphone className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-white truncate">Pixel 9 Pro · Virtual</p>
              <p className="text-[10px] text-emerald-300/90 truncate">
                {targetMacPeer
                  ? `Paired with ${targetMacPeer.device.name}`
                  : 'Linking over Warp E2EE…'}
              </p>
            </div>
          </div>
          <span className="text-[10px] font-mono-tabular px-2 py-0.5 rounded-full bg-slate-900 text-emerald-400 border border-emerald-500/30">
            LIVE PEER
          </span>
        </div>

        {/* Incoming AirDrop Prompt inside Android Screen (when sending MacBook -> Android!) */}
        {pendingOffer && (
          <div className="mt-3 rounded-2xl bg-sky-500/15 border border-sky-400/40 p-3 space-y-2 animate-pulse">
            <p className="text-xs font-semibold text-white">
              Incoming from {pendingOffer.peerName}
            </p>
            <p className="text-[11px] text-slate-300 font-mono-tabular">
              {pendingOffer.files.length} file(s) · {formatBytes(pendingOffer.totalBytes)}
            </p>
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                type="button"
                onClick={() => clientRef.current?.declineIncomingTransfer(pendingOffer.transferId)}
                className="py-1.5 rounded-xl text-xs font-semibold bg-white/10 hover:bg-rose-500/30 text-white cursor-pointer"
              >
                Decline
              </button>
              <button
                type="button"
                onClick={() => clientRef.current?.acceptIncomingTransfer(pendingOffer.transferId)}
                className="py-1.5 rounded-xl text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 text-slate-950 cursor-pointer"
              >
                Accept
              </button>
            </div>
          </div>
        )}

        {/* 1-Tap Beam Actions: Android -> MacBook */}
        <div className="mt-3.5 space-y-2">
          <p className="text-[11px] font-medium text-slate-400 px-1">
            Tap on Pixel 9 Pro to AirBridge to your MacBook:
          </p>

          <button
            type="button"
            disabled={!targetMacPeer}
            onClick={sendSamplePhoto}
            className="w-full p-2.5 rounded-2xl bg-white/[0.06] hover:bg-emerald-500/20 border border-white/10 hover:border-emerald-500/40 disabled:opacity-40 flex items-center justify-between text-left transition-all cursor-pointer"
          >
            <div className="flex items-center gap-2.5">
              <ImageIcon className="w-4 h-4 text-emerald-400" />
              <div>
                <p className="text-xs font-semibold text-white">Beam Sample Camera Photo</p>
                <p className="text-[10px] text-slate-400">
                  PXL_20261024_NIGHTSIGHT.png (with live preview)
                </p>
              </div>
            </div>
            <Send className="w-3.5 h-3.5 text-emerald-400" />
          </button>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={!targetMacPeer}
              onClick={sendSamplePdf}
              className="p-2.5 rounded-2xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 disabled:opacity-40 flex items-center gap-2 text-xs font-medium text-slate-200 cursor-pointer"
            >
              <FileText className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span className="truncate">Sample .pdf</span>
            </button>

            <button
              type="button"
              disabled={!targetMacPeer}
              onClick={() => filePickerRef.current?.click()}
              className="p-2.5 rounded-2xl bg-white/[0.06] hover:bg-white/[0.1] border border-white/10 disabled:opacity-40 flex items-center gap-2 text-xs font-medium text-slate-200 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">Pick File…</span>
            </button>
            <input
              ref={filePickerRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const list = e.target.files;
                if (list && list.length > 0 && targetMacPeer && clientRef.current) {
                  clientRef.current.sendFiles(
                    targetMacPeer.peerId,
                    Array.from(list).map((f) => wrapBrowserFile(f))
                  );
                }
              }}
            />
          </div>

          {/* Beam OTP / Clipboard from Android -> MacBook */}
          <form onSubmit={sendSimClipboard} className="pt-1 flex items-center gap-1.5">
            <div className="relative flex-1">
              <KeyRound className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={clipDraft}
                onChange={(e) => setClipDraft(e.target.value)}
                placeholder="OTP or URL from Android…"
                className="w-full pl-8 pr-2.5 py-1.5 rounded-xl bg-white/[0.06] border border-white/10 text-xs font-mono-tabular text-white focus:outline-none focus:border-emerald-400"
              />
            </div>
            <button
              type="submit"
              disabled={!targetMacPeer || !clipDraft.trim()}
              className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-400 hover:bg-emerald-300 disabled:opacity-40 text-slate-950 shrink-0 cursor-pointer"
            >
              Beam OTP
            </button>
          </form>
        </div>

        {/* Pixel Activity Feed (Shows files & clips sent from MacBook -> Android!) */}
        <div className="mt-3.5 pt-3 border-t border-white/10 space-y-2 max-h-[165px] overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-slate-400 font-semibold">
            Pixel 9 Pro Activity
          </p>
          {snap && snap.transfers.length === 0 && snap.clipboardItems.length === 0 && (
            <p className="text-[11px] text-slate-500">
              Drop any file onto &ldquo;Pixel 9 Pro · Virtual&rdquo; on the radar to receive it here!
            </p>
          )}

          {snap?.transfers.slice(0, 3).map((tr) => (
            <div
              key={tr.transferId}
              className="rounded-xl bg-white/[0.05] p-2 text-[11px] space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-slate-200 truncate">
                  {tr.direction === 'incoming' ? '⬇ ' : '⬆ '}
                  {tr.files[0]?.name}
                  {tr.files.length > 1 ? ` +${tr.files.length - 1}` : ''}
                </span>
                <span className="font-mono-tabular text-[10px] text-emerald-400 shrink-0">
                  {tr.status === 'transferring'
                    ? formatSpeed(tr.speedBytesPerSec)
                    : tr.status}
                </span>
              </div>
              {tr.status === 'completed' && tr.receivedFiles.length > 0 && (
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => triggerSingleFileDownload(tr.receivedFiles[0])}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[10px] font-semibold cursor-pointer"
                  >
                    <Download className="w-2.5 h-2.5" />
                    Save on Android
                  </button>
                </div>
              )}
            </div>
          ))}

          {snap?.clipboardItems.slice(0, 2).map((c) => (
            <div
              key={c.beamId}
              className="rounded-xl bg-white/[0.05] p-2 text-[11px] flex items-center justify-between gap-2"
            >
              <span className="font-mono-tabular text-slate-300 truncate">
                📋 {c.text}
              </span>
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(c.text).catch(() => {});
                  setCopiedId(c.beamId);
                  setTimeout(() => setCopiedId(null), 1200);
                }}
                className="text-emerald-400 shrink-0 cursor-pointer"
              >
                {copiedId === c.beamId ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Android Gesture Pill */}
      <div className="pt-3 flex justify-center">
        <div className="w-28 h-1 rounded-full bg-white/25" />
      </div>
    </div>
  );
}
