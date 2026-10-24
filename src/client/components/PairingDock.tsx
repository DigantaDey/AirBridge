import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import {
  Archive,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ClipboardCheck,
  Copy,
  Download,
  ExternalLink,
  FileCheck2,
  Link2,
  QrCode,
  RefreshCw,
  ShieldCheck,
  XCircle,
  Zap,
} from "lucide-react";
import {
  formatBytes,
  formatPairCode,
  formatSpeed,
  normalizePairCode,
} from "../../shared/protocol.js";
import type {
  ClipboardBeamItem,
  TransferSessionView,
} from "../engine/warpClient.js";
import {
  triggerBatchZipDownload,
  triggerSingleFileDownload,
} from "../engine/fileDropUtils.js";

interface PairingDockProps {
  pairCode: string;
  lanUrls: string[];
  transfers: TransferSessionView[];
  clipboardItems: ClipboardBeamItem[];
  onJoinPairCode: (code: string) => void;
  onRotatePairCode: () => void;
  onCancelTransfer: (transferId: string) => void;
  onMarkCopied?: (text: string) => void;
}

export function PairingDock({
  pairCode,
  lanUrls,
  transfers,
  clipboardItems,
  onJoinPairCode,
  onRotatePairCode,
  onCancelTransfer,
  onMarkCopied,
}: PairingDockProps) {
  const [qrSvg, setQrSvg] = useState<string>("");
  const [joinInput, setJoinInput] = useState("");
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedBeamId, setCopiedBeamId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"transfers" | "clipboard">(
    "transfers",
  );

  const pairUrl = useMemo(() => {
    if (typeof window === "undefined" || !pairCode) return "";
    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    const baseOrigin =
      isLocalhost && lanUrls.length > 0 ? lanUrls[0] : window.location.origin;
    return `${baseOrigin}/?pair=${pairCode}`;
  }, [pairCode, lanUrls]);

  useEffect(() => {
    if (!pairUrl) return;
    let cancelled = false;
    QRCode.toString(pairUrl, {
      type: "svg",
      margin: 1,
      errorCorrectionLevel: "M",
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    })
      .then((svg) => {
        if (!cancelled) setQrSvg(svg);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pairUrl]);

  const copyPairCode = () => {
    if (!pairCode) return;
    const formatted = formatPairCode(pairCode);
    onMarkCopied?.(formatted);
    navigator.clipboard?.writeText(formatted).catch(() => {});
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 1800);
  };

  const copyPairLink = () => {
    if (!pairUrl) return;
    onMarkCopied?.(pairUrl);
    navigator.clipboard?.writeText(pairUrl).catch(() => {});
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 1800);
  };

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = normalizePairCode(joinInput);
    if (clean.length === 6) {
      onJoinPairCode(clean);
      setJoinInput("");
    }
  };

  return (
    <aside className="flex flex-col gap-5">
      {/* Instant Cross-Network Pairing Card */}
      <div className="rounded-3xl ab-glass p-5">
        <div className="flex items-center justify-between gap-2 mb-3.5">
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-[var(--ab-text)]">
              Connect a device
            </h2>
          </div>
          <button
            type="button"
            onClick={onRotatePairCode}
            title="Generate a fresh Warp pairing room"
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-[var(--ab-muted)] hover:text-[var(--ab-text)] hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            New Room
          </button>
        </div>

        <div className="flex flex-col sm:flex-row lg:flex-row items-center gap-4">
          {/* High-Contrast Scannable QR */}
          <div className="w-32 h-32 rounded-2xl bg-white p-2 shadow-md shrink-0 flex items-center justify-center border border-slate-200">
            {qrSvg ? (
              <div
                className="w-full h-full [&>svg]:w-full [&>svg]:h-full"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            ) : (
              <div className="w-6 h-6 rounded-full border-2 border-slate-300 border-t-sky-500 animate-spin" />
            )}
          </div>

          <div className="flex-1 w-full text-center sm:text-left">
            <p className="text-[11px] text-[var(--ab-muted)] leading-relaxed">
              Scan with your Android camera or enter this pairing code on your
              other device:
            </p>

            <div className="mt-2 flex items-center justify-center sm:justify-start gap-2">
              <button
                type="button"
                onClick={copyPairCode}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl ab-elevated font-mono-tabular text-base font-bold tracking-wider text-sky-500 dark:text-sky-400 hover:border-sky-500/50 transition-colors cursor-pointer"
                title="Click to copy pairing code"
              >
                <span>{pairCode ? formatPairCode(pairCode) : "···-···"}</span>
                {copiedCode ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5 text-[var(--ab-muted)]" />
                )}
              </button>

              <button
                type="button"
                onClick={copyPairLink}
                title="Copy direct pairing URL"
                className="p-2 rounded-xl ab-elevated text-[var(--ab-muted)] hover:text-[var(--ab-text)] transition-colors cursor-pointer"
              >
                {copiedLink ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Link2 className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* Join Existing Room Input */}
            <form
              onSubmit={handleJoinSubmit}
              className="mt-3 flex items-center gap-1.5"
            >
              <input
                type="text"
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
                placeholder="Enter peer code (e.g. K7M-9P2)"
                maxLength={7}
                className="w-full min-w-0 px-2.5 py-1.5 rounded-xl text-xs font-mono-tabular ab-elevated text-[var(--ab-text)] placeholder:text-[var(--ab-muted)] focus:outline-none focus:ring-2 focus:ring-sky-500/60"
              />
              <button
                type="submit"
                disabled={normalizePairCode(joinInput).length !== 6}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-sky-500 hover:bg-sky-400 disabled:opacity-40 text-slate-950 transition-colors shrink-0 cursor-pointer disabled:cursor-not-allowed"
              >
                Pair
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Live Transfers & Universal Clipboard Vault */}
      <div className="rounded-3xl ab-glass p-5 flex-1 flex flex-col min-h-[310px]">
        <div className="flex items-center justify-between gap-2 pb-3 border-b border-[var(--ab-border)]">
          <div className="flex items-center gap-1 p-1 rounded-xl bg-black/[0.04] dark:bg-white/[0.04]">
            <button
              type="button"
              onClick={() => setActiveTab("transfers")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                activeTab === "transfers"
                  ? "bg-white dark:bg-slate-800 text-[var(--ab-text)] shadow-sm"
                  : "text-[var(--ab-muted)] hover:text-[var(--ab-text)]"
              }`}
            >
              Transfers ({transfers.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("clipboard")}
              className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                activeTab === "clipboard"
                  ? "bg-white dark:bg-slate-800 text-[var(--ab-text)] shadow-sm"
                  : "text-[var(--ab-muted)] hover:text-[var(--ab-text)]"
              }`}
            >
              Clipboard ({clipboardItems.length})
            </button>
          </div>
        </div>

        {activeTab === "transfers" ? (
          <div className="mt-3.5 flex-1 space-y-3 overflow-y-auto max-h-[380px] pr-1">
            {transfers.length === 0 ? (
              <div className="h-44 flex flex-col items-center justify-center text-center px-4">
                <FileCheck2 className="w-8 h-8 text-[var(--ab-muted)] opacity-50 mb-2" />
                <p className="text-xs font-medium text-[var(--ab-text-secondary)]">
                  No transfers in this session yet
                </p>
                <p className="text-[11px] text-[var(--ab-muted)] mt-0.5">
                  Sent and received files appear here with SHA-256 verification
                  and 1-click ZIP save.
                </p>
              </div>
            ) : (
              transfers.map((tr) => {
                const pct =
                  tr.totalBytes > 0
                    ? Math.min(
                        100,
                        Math.round((tr.transferredBytes / tr.totalBytes) * 100),
                      )
                    : tr.status === "completed"
                      ? 100
                      : 0;
                const isActive =
                  tr.status === "transferring" ||
                  tr.status === "pending-accept" ||
                  tr.status === "connecting";

                return (
                  <div
                    key={tr.transferId}
                    className="rounded-2xl ab-elevated p-3.5 space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div
                          className={`p-1.5 rounded-lg shrink-0 ${
                            tr.direction === "incoming"
                              ? "bg-emerald-500/15 text-emerald-400"
                              : "bg-sky-500/15 text-sky-400"
                          }`}
                        >
                          {tr.direction === "incoming" ? (
                            <ArrowDownLeft className="w-4 h-4" />
                          ) : (
                            <ArrowUpRight className="w-4 h-4" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-semibold text-[var(--ab-text)] truncate">
                            {tr.files.length === 1
                              ? tr.files[0].name
                              : `${tr.files.length} files (${formatBytes(tr.totalBytes)})`}
                          </p>
                          <p className="text-[11px] text-[var(--ab-muted)] truncate">
                            {tr.direction === "incoming" ? "From" : "To"}{" "}
                            {tr.peerName} ·{" "}
                            <span className="font-mono-tabular">
                              {formatBytes(tr.totalBytes)}
                            </span>
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-black/[0.04] dark:bg-white/[0.05] text-[var(--ab-muted)]">
                          <Zap className="w-2.5 h-2.5 text-sky-400" />
                          {tr.transport === "webrtc" ? "P2P" : "E2EE WSS"}
                        </span>
                        {isActive && (
                          <button
                            type="button"
                            onClick={() => onCancelTransfer(tr.transferId)}
                            className="p-1 text-[var(--ab-muted)] hover:text-rose-400 cursor-pointer"
                            title="Cancel transfer"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div>
                      <div className="h-1.5 w-full rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-150 ${
                            tr.status === "completed"
                              ? "bg-emerald-400"
                              : tr.status === "declined" ||
                                  tr.status === "cancelled" ||
                                  tr.status === "error"
                                ? "bg-rose-400"
                                : "bg-sky-400"
                          }`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="mt-1 flex items-center justify-between text-[10px] font-mono-tabular text-[var(--ab-muted)]">
                        <span>
                          {tr.status === "pending-accept"
                            ? "Waiting for recipient to accept…"
                            : tr.status === "transferring"
                              ? `${pct}% · ${formatSpeed(tr.speedBytesPerSec)}${
                                  tr.etaSeconds
                                    ? ` · ${tr.etaSeconds}s left`
                                    : ""
                                }`
                              : tr.status === "completed"
                                ? "100% · Verified SHA-256"
                                : tr.status.toUpperCase()}
                        </span>
                        <span>🔐 {tr.sasCode}</span>
                      </div>
                    </div>

                    {/* Completed Received File Download Actions */}
                    {tr.status === "completed" &&
                      tr.receivedFiles.length > 0 && (
                        <div className="pt-2 border-t border-[var(--ab-border)] space-y-1.5">
                          {tr.receivedFiles.slice(0, 4).map((rf) => {
                            const isPdf =
                              rf.mimeType === "application/pdf" ||
                              rf.name.toLowerCase().endsWith(".pdf");
                            return (
                              <div
                                key={rf.index}
                                className="flex items-center justify-between gap-2 text-xs"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  {rf.blobUrl &&
                                    rf.mimeType.startsWith("image/") && (
                                      <img
                                        src={rf.blobUrl}
                                        alt={rf.name}
                                        className="w-7 h-7 rounded-md object-cover border border-white/10 shrink-0"
                                      />
                                    )}
                                  {isPdf && (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/25 shrink-0">
                                      PDF
                                    </span>
                                  )}
                                  <span className="truncate text-[var(--ab-text-secondary)]">
                                    {rf.name}
                                  </span>
                                  {rf.verified && (
                                    <span title={`SHA-256: ${rf.sha256}`}>
                                      <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                    </span>
                                  )}
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                  {isPdf && rf.blobUrl && (
                                    <a
                                      href={rf.blobUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-sky-500/15 hover:bg-sky-500/25 text-sky-500 dark:text-sky-300"
                                    >
                                      <ExternalLink className="w-3 h-3" />
                                      View
                                    </a>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() =>
                                      triggerSingleFileDownload(rf)
                                    }
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-500 dark:text-emerald-300 shrink-0 cursor-pointer"
                                  >
                                    <Download className="w-3 h-3" />
                                    Save
                                  </button>
                                </div>
                              </div>
                            );
                          })}

                          {tr.receivedFiles.length > 1 && (
                            <button
                              type="button"
                              onClick={() =>
                                triggerBatchZipDownload(
                                  tr.receivedFiles,
                                  `AirBridge-${tr.peerName.replace(/\s+/g, "-")}`,
                                )
                              }
                              className="w-full mt-1.5 py-1.5 rounded-xl text-xs font-semibold bg-sky-500/15 hover:bg-sky-500/25 text-sky-500 dark:text-sky-300 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              <Archive className="w-3.5 h-3.5" />
                              Save All {tr.receivedFiles.length} Files (.zip)
                            </button>
                          )}
                        </div>
                      )}
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <div className="mt-3.5 flex-1 space-y-2.5 overflow-y-auto max-h-[380px] pr-1">
            {clipboardItems.length === 0 ? (
              <div className="h-44 flex flex-col items-center justify-center text-center px-4">
                <ClipboardCheck className="w-8 h-8 text-[var(--ab-muted)] opacity-50 mb-2" />
                <p className="text-xs font-medium text-[var(--ab-text-secondary)]">
                  Universal Clipboard is empty
                </p>
                <p className="text-[11px] text-[var(--ab-muted)] mt-0.5">
                  Beam OTP codes, links, or snippets between Android and MacBook
                  with zero cloud logs.
                </p>
              </div>
            ) : (
              clipboardItems.map((clip) => (
                <div
                  key={clip.beamId}
                  className="rounded-2xl ab-elevated p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--ab-muted)]">
                    <span>
                      {clip.direction === "incoming"
                        ? `From ${clip.peerName}`
                        : `To ${clip.peerName}`}
                    </span>
                    <span className="uppercase px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 font-semibold text-[10px]">
                      {clip.contentType}
                    </span>
                  </div>
                  <pre className="text-xs font-mono-tabular text-[var(--ab-text)] whitespace-pre-wrap break-all bg-black/[0.04] dark:bg-white/[0.03] p-2.5 rounded-xl max-h-24 overflow-y-auto m-0">
                    {clip.text}
                  </pre>
                  <div className="flex items-center justify-end gap-2">
                    {clip.contentType === "url" && (
                      <a
                        href={clip.text}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-sky-500/15 text-sky-400 hover:bg-sky-500/25"
                      >
                        <ExternalLink className="w-3 h-3" />
                        Open URL
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard
                          ?.writeText(clip.text)
                          .catch(() => {});
                        setCopiedBeamId(clip.beamId);
                        setTimeout(() => setCopiedBeamId(null), 1500);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 cursor-pointer"
                    >
                      {copiedBeamId === clip.beamId ? (
                        <>
                          <Check className="w-3 h-3" />
                          Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          Copy
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
