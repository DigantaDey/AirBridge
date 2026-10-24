import { useRef, useState } from 'react';
import {
  Check,
  ClipboardPaste,
  FolderUp,
  HardDriveDownload,
  Lock,
  Pencil,
  Send,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Upload,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import {
  type DeviceProfile,
  type LocalDaemonStatus,
  type PeerSummary,
  formatBytes,
} from '../../shared/protocol.js';
import {
  type PeerSecurityInfo,
  type SendableFileInput,
  wrapBrowserFile,
} from '../engine/warpClient.js';
import { extractDroppedFiles } from '../engine/fileDropUtils.js';
import { DeviceHardwareIcon } from './DeviceIcons.js';

interface RadarStageProps {
  myDevice: DeviceProfile | null;
  localDaemon: LocalDaemonStatus;
  peers: PeerSummary[];
  peerSecurity: Record<string, PeerSecurityInfo>;
  trustedPeerKeys: string[];
  stagedFiles: SendableFileInput[];
  onClearStagedFiles: () => void;
  onStageFiles: (files: SendableFileInput[]) => void;
  onSendFilesToPeer: (peerId: string, files: SendableFileInput[]) => void;
  onOpenClipboardForPeer: (peer: PeerSummary) => void;
  onToggleTrustPeer: (publicKey: string, trusted: boolean) => void;
  onRenameDevice: (newName: string) => void;
  onOpenSimulator: () => void;
}

const ORBITAL_POSITIONS: Array<{ xPercent: number; yPercent: number }> = [
  { xPercent: 50, yPercent: 17 },
  { xPercent: 80, yPercent: 50 },
  { xPercent: 20, yPercent: 50 },
  { xPercent: 74, yPercent: 23 },
  { xPercent: 26, yPercent: 23 },
  { xPercent: 74, yPercent: 77 },
  { xPercent: 26, yPercent: 77 },
  { xPercent: 50, yPercent: 83 },
];

export function RadarStage({
  myDevice,
  localDaemon,
  peers,
  peerSecurity,
  trustedPeerKeys,
  stagedFiles,
  onClearStagedFiles,
  onStageFiles,
  onSendFilesToPeer,
  onOpenClipboardForPeer,
  onToggleTrustPeer,
  onRenameDevice,
  onOpenSimulator,
}: RadarStageProps) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [dragActiveGlobal, setDragActiveGlobal] = useState(false);
  const [dragHoverPeerId, setDragHoverPeerId] = useState<string | null>(null);
  const [targetPeerIdForPicker, setTargetPeerIdForPicker] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const handleOpenFilePicker = (peerId: string) => {
    if (stagedFiles.length > 0) {
      onSendFilesToPeer(peerId, stagedFiles);
      onClearStagedFiles();
      return;
    }
    setTargetPeerIdForPicker(peerId);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const handleOpenFolderPicker = (peerId: string) => {
    setTargetPeerIdForPicker(peerId);
    if (folderInputRef.current) {
      folderInputRef.current.value = '';
      folderInputRef.current.click();
    }
  };

  const handleFilesChosen = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const wrapped = Array.from(fileList).map((f) => wrapBrowserFile(f));
    if (targetPeerIdForPicker) {
      onSendFilesToPeer(targetPeerIdForPicker, wrapped);
    } else if (peers.length === 1) {
      onSendFilesToPeer(peers[0].peerId, wrapped);
    } else {
      onStageFiles(wrapped);
    }
  };

  const handleStageDrop = async (e: React.DragEvent, explicitPeerId?: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActiveGlobal(false);
    setDragHoverPeerId(null);

    const extracted = await extractDroppedFiles(e.dataTransfer);
    if (extracted.length === 0) return;

    if (explicitPeerId) {
      onSendFilesToPeer(explicitPeerId, extracted);
    } else if (peers.length === 1) {
      onSendFilesToPeer(peers[0].peerId, extracted);
    } else {
      onStageFiles(extracted);
    }
  };

  const startRename = () => {
    setDraftName(myDevice?.name || '');
    setEditingName(true);
  };

  const commitRename = () => {
    if (draftName.trim()) {
      onRenameDevice(draftName.trim());
    }
    setEditingName(false);
  };

  const totalStagedBytes = stagedFiles.reduce((s, f) => s + f.size, 0);

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault();
        setDragActiveGlobal(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setDragActiveGlobal(false);
        }
      }}
      onDrop={(e) => handleStageDrop(e)}
      className={`relative flex flex-col justify-between rounded-3xl ab-glass overflow-hidden min-h-[540px] lg:min-h-[640px] p-5 sm:p-7 transition-all ${
        dragActiveGlobal
          ? 'ring-2 ring-emerald-400/70 bg-emerald-500/[0.04]'
          : ''
      }`}
    >
      {/* Hidden File & Directory Inputs */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => handleFilesChosen(e.target.files)}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is standard across Chromium/WebKit/Gecko
        webkitdirectory=""
        directory=""
        className="hidden"
        onChange={(e) => handleFilesChosen(e.target.files)}
      />

      {/* Ambient Subtle Glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
      >
        <div className="w-[460px] h-[460px] rounded-full bg-sky-500/[0.06] dark:bg-sky-500/[0.07] blur-3xl" />
      </div>

      {/* Top Radar Status Header */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-sky-500" />
          </span>
          <span className="text-xs font-medium tracking-wide uppercase text-[var(--ab-muted)]">
            {peers.length > 0
              ? `${peers.length} Device${peers.length > 1 ? 's' : ''} in Warp Range`
              : 'Scanning Nearby Wi-Fi & Paired Warp Room'}
          </span>
        </div>

        <div className="flex items-center gap-2 text-xs text-[var(--ab-muted)]">
          {localDaemon.enabled && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/20 font-medium">
              <HardDriveDownload className="w-3.5 h-3.5" />
              Auto-Save ~/Downloads
            </span>
          )}
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/[0.03] dark:bg-white/[0.04] border border-[var(--ab-border)]">
            <Lock className="w-3 h-3 text-emerald-500" />
            ECDH P-256 · AES-256-GCM
          </span>
        </div>
      </div>

      {/* Staged Files Banner (from Drag-Drop or Android Native Share Sheet) */}
      {stagedFiles.length > 0 && (
        <div className="relative z-20 mt-4 p-3.5 rounded-2xl bg-sky-500/10 border border-sky-500/30 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-2 rounded-xl bg-sky-500/20 text-sky-400">
              <Upload className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[var(--ab-text)] truncate">
                {stagedFiles.length} file{stagedFiles.length > 1 ? 's' : ''} staged (
                {formatBytes(totalStagedBytes)})
              </p>
              <p className="text-[11px] text-[var(--ab-muted)] truncate">
                {peers.length > 0
                  ? 'Tap any device below to beam immediately'
                  : 'Pair your Android or MacBook to beam staged files'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {peers[0] && (
              <button
                type="button"
                onClick={() => {
                  onSendFilesToPeer(peers[0].peerId, stagedFiles);
                  onClearStagedFiles();
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950 transition-colors cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                Beam to {peers[0].device.name.split('·')[0].trim()}
              </button>
            )}
            <button
              type="button"
              onClick={onClearStagedFiles}
              className="p-1.5 rounded-lg text-[var(--ab-muted)] hover:text-[var(--ab-text)] cursor-pointer"
              aria-label="Clear staged files"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Concentric Spatial Radar Stage */}
      <div className="relative flex-1 flex flex-col items-center justify-center my-4 min-h-[370px]">
        {/* Concentric Geometric Rings */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <div className="w-[210px] h-[210px] sm:w-[240px] sm:h-[240px] rounded-full border border-[var(--ab-radar-line)]" />
          <div className="absolute w-[330px] h-[330px] sm:w-[380px] sm:h-[380px] rounded-full border border-[var(--ab-radar-line)]" />
          <div className="absolute w-[450px] h-[450px] sm:w-[520px] sm:h-[520px] rounded-full border border-dashed border-[var(--ab-radar-line)]" />
          <div className="absolute w-[240px] h-[240px] rounded-full border border-sky-400/25 animate-radar-pulse" />
        </div>

        {/* Desktop Orbital Peer Nodes */}
        <div className="hidden md:block absolute inset-0 pointer-events-none">
          {peers.slice(0, 8).map((peer, idx) => {
            const pos = ORBITAL_POSITIONS[idx % ORBITAL_POSITIONS.length];
            const sec = peerSecurity[peer.peerId];
            const isTrusted = trustedPeerKeys.includes(peer.device.publicKey);
            const isAndroid = peer.device.platform === 'android';
            const isHovered = dragHoverPeerId === peer.peerId;

            return (
              <div
                key={peer.peerId}
                style={{ left: `${pos.xPercent}%`, top: `${pos.yPercent}%` }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDragHoverPeerId(peer.peerId);
                }}
                onDragLeave={() => setDragHoverPeerId(null)}
                onDrop={(e) => handleStageDrop(e, peer.peerId)}
                className={`pointer-events-auto -translate-x-1/2 -translate-y-1/2 absolute z-20 transition-all duration-200 ${
                  isHovered ? 'scale-105' : 'hover:-translate-y-[52%]'
                }`}
              >
                <div
                  className={`group w-[228px] rounded-2xl ab-elevated p-3 shadow-xl transition-all ${
                    isHovered
                      ? 'ring-2 ring-emerald-400 border-emerald-400'
                      : 'hover:border-sky-500/45'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => handleOpenFilePicker(peer.peerId)}
                      className="flex items-center gap-2.5 text-left min-w-0 flex-1 cursor-pointer"
                    >
                      <div
                        className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${
                          isAndroid
                            ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/25'
                            : 'bg-sky-500/12 text-sky-400 border-sky-500/25'
                        }`}
                      >
                        <DeviceHardwareIcon
                          platform={peer.device.platform}
                          formFactor={peer.device.formFactor}
                          className="w-6 h-6"
                        />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-[var(--ab-text)] truncate">
                          {peer.device.name}
                        </p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] font-medium ${
                              sec?.rtcConnected
                                ? 'text-emerald-500 dark:text-emerald-400'
                                : 'text-sky-500 dark:text-sky-400'
                            }`}
                          >
                            {sec?.rtcConnected ? (
                              <>
                                <Zap className="w-2.5 h-2.5" />
                                P2P Direct
                              </>
                            ) : (
                              <>
                                <Wifi className="w-2.5 h-2.5" />
                                E2EE Ready
                              </>
                            )}
                          </span>
                          {sec?.rttMs !== null && sec?.rttMs !== undefined && (
                            <span className="text-[10px] text-[var(--ab-muted)] font-mono-tabular">
                              · {sec.rttMs}ms
                            </span>
                          )}
                        </div>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => onToggleTrustPeer(peer.device.publicKey, !isTrusted)}
                      title={
                        isTrusted
                          ? 'Trusted Device (Auto-Accepts Incoming Files)'
                          : 'Click to Trust Device for Auto-Accept'
                      }
                      className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                        isTrusted
                          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                          : 'text-[var(--ab-muted)] border-transparent hover:border-[var(--ab-border)]'
                      }`}
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* Quick Actions Row */}
                  <div className="mt-2.5 pt-2 border-t border-[var(--ab-border)] flex items-center justify-between gap-1.5">
                    <span
                      title="End-to-End Encryption Security Verification Code (matches on both screens)"
                      className="text-[10px] font-mono-tabular text-[var(--ab-muted)] px-1.5 py-0.5 rounded bg-black/[0.04] dark:bg-white/[0.04]"
                    >
                      🔐 {sec?.sasCode ?? '··· ···'}
                    </span>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => handleOpenFilePicker(peer.peerId)}
                        title="Send files"
                        className="px-2 py-1 rounded-lg text-[11px] font-medium bg-sky-500/15 hover:bg-sky-500/25 text-sky-600 dark:text-sky-300 transition-colors cursor-pointer"
                      >
                        Drop / Send
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenFolderPicker(peer.peerId)}
                        title="Send entire folder"
                        className="p-1 rounded-lg text-[var(--ab-muted)] hover:text-[var(--ab-text)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                      >
                        <FolderUp className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenClipboardForPeer(peer)}
                        title="Universal Clipboard: Beam text, URL, OTP or code"
                        className="p-1 rounded-lg text-[var(--ab-muted)] hover:text-[var(--ab-text)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
                      >
                        <ClipboardPaste className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Center Focal Node: THIS DEVICE (You) */}
        <div className="relative z-10 flex flex-col items-center text-center">
          <div className="relative group">
            <div className="w-20 h-20 rounded-3xl ab-elevated shadow-2xl flex items-center justify-center text-sky-400 border border-sky-500/30">
              <DeviceHardwareIcon
                platform={myDevice?.platform ?? 'macos'}
                formFactor={myDevice?.formFactor}
                className="w-10 h-10"
              />
            </div>
            <span className="absolute -bottom-1 -right-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-500 text-slate-950 shadow">
              YOU
            </span>
          </div>

          <div className="mt-3 flex items-center gap-1.5">
            {editingName ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  commitRename();
                }}
                className="flex items-center gap-1"
              >
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  maxLength={32}
                  autoFocus
                  onBlur={commitRename}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium ab-elevated text-[var(--ab-text)] focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
                <button
                  type="submit"
                  className="p-1 rounded-lg bg-sky-500 text-slate-950 cursor-pointer"
                >
                  <Check className="w-3.5 h-3.5" />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={startRename}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-semibold text-[var(--ab-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05] transition-colors cursor-pointer"
                title="Click to customize your device name"
              >
                <span>{myDevice?.name ?? 'Initializing…'}</span>
                <Pencil className="w-3 h-3 text-[var(--ab-muted)]" />
              </button>
            )}
          </div>
          <p className="text-[11px] text-[var(--ab-muted)]">
            {peers.length > 0
              ? 'Click a device or drag files & folders anywhere to AirBridge'
              : 'Waiting for your Android or MacBook peer…'}
          </p>

          {/* Helpful Zero-Peer Onboarding Action Pill */}
          {peers.length === 0 && (
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onOpenSimulator}
                className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30 transition-all cursor-pointer"
              >
                <Smartphone className="w-4 h-4" />
                <span>Test Now: Spawn Live Pixel 9 Pro Peer</span>
                <Sparkles className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Mobile Peer Cards Stack (on narrow Android screens) */}
        {peers.length > 0 && (
          <div className="md:hidden w-full mt-6 grid grid-cols-1 gap-2.5 relative z-20">
            {peers.map((peer) => {
              const sec = peerSecurity[peer.peerId];
              const isAndroid = peer.device.platform === 'android';
              return (
                <div
                  key={peer.peerId}
                  className="rounded-2xl ab-elevated p-3.5 flex items-center justify-between gap-3"
                >
                  <button
                    type="button"
                    onClick={() => handleOpenFilePicker(peer.peerId)}
                    className="flex items-center gap-3 text-left min-w-0 flex-1"
                  >
                    <div
                      className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border ${
                        isAndroid
                          ? 'bg-emerald-500/12 text-emerald-400 border-emerald-500/25'
                          : 'bg-sky-500/12 text-sky-400 border-sky-500/25'
                      }`}
                    >
                      <DeviceHardwareIcon
                        platform={peer.device.platform}
                        formFactor={peer.device.formFactor}
                        className="w-6 h-6"
                      />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[var(--ab-text)] truncate">
                        {peer.device.name}
                      </p>
                      <p className="text-[11px] text-[var(--ab-muted)] font-mono-tabular">
                        {sec?.rtcConnected ? '⚡ P2P Direct' : '🔒 E2EE Ready'} · 🔐{' '}
                        {sec?.sasCode ?? '···'}
                      </p>
                    </div>
                  </button>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenClipboardForPeer(peer)}
                      className="p-2.5 rounded-xl bg-black/[0.04] dark:bg-white/[0.05] text-[var(--ab-text)]"
                      aria-label="Send clipboard text"
                    >
                      <ClipboardPaste className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenFilePicker(peer.peerId)}
                      className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-sky-500 text-slate-950"
                    >
                      Send
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom Footer Hint Bar */}
      <div className="relative z-10 pt-3 border-t border-[var(--ab-border)] flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--ab-muted)]">
        <span>
          Drop photos, 4K videos, APKs, DMGs, or entire folders — zero cloud storage, zero compression.
        </span>
        <span className="font-mono-tabular">Warp v1 · 64KB AES-GCM Stream</span>
      </div>

      {/* Full-Stage Magnetic Drop Overlay */}
      {dragActiveGlobal && (
        <div className="pointer-events-none absolute inset-3 rounded-2xl border-2 border-dashed border-emerald-400/80 bg-emerald-500/10 backdrop-blur-[2px] z-30 flex flex-col items-center justify-center text-center p-6">
          <Upload className="w-10 h-10 text-emerald-400 mb-2 animate-bounce" />
          <p className="text-base font-semibold text-[var(--ab-text)]">
            {peers.length === 1
              ? `Drop to beam straight to ${peers[0].device.name}`
              : peers.length > 1
                ? 'Drop onto a specific device node or release to stage files'
                : 'Drop files or folders to stage for transfer'}
          </p>
          <p className="text-xs text-[var(--ab-muted)] mt-1">
            Original quality preserved · End-to-End Encrypted
          </p>
        </div>
      )}
    </section>
  );
}
