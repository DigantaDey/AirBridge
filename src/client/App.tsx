import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Sparkles, X } from "lucide-react";
import type { PeerSummary, VisibilityMode } from "../shared/protocol.js";
import {
  loadOrCreateDeviceProfile,
  saveDeviceName,
} from "./engine/deviceDetect.js";
import {
  playBeamSentPulse,
  playIncomingChime,
  playTransferCompleteChime,
} from "./engine/soundEffects.js";
import {
  WarpClient,
  type ClipboardBeamItem,
  type SendableFileInput,
  type WarpClientSnapshot,
  wrapBrowserFile,
} from "./engine/warpClient.js";
import { consumePwaSharedPayload } from "./engine/fileDropUtils.js";
import { HeaderBar } from "./components/HeaderBar.js";
import { RadarStage } from "./components/RadarStage.js";
import { PairingDock } from "./components/PairingDock.js";
import { TransferModal } from "./components/TransferModal.js";
import { ClipboardModal } from "./components/ClipboardModal.js";
import { SetupGuideModal } from "./components/SetupGuideModal.js";
import { CompanionSimulator } from "./components/CompanionSimulator.js";

interface ToastNotice {
  id: string;
  title: string;
  body: string;
  copyText?: string;
}

export function App() {
  // Capture the invitation during render, before an effect cleans the address bar.
  // React StrictMode replays effects in development; rereading the cleaned URL
  // on the second run used to silently discard the phone's pairing invitation.
  const [initialPairCode] = useState(
    () => new URLSearchParams(window.location.search).get("pair") || undefined,
  );
  const clientRef = useRef<WarpClient | null>(null);
  const soundMutedRef = useRef<boolean>(false);

  const [snap, setSnap] = useState<WarpClientSnapshot>({
    connectionState: "connecting",
    peerId: "",
    pairCode: "",
    formattedPairCode: "",
    visibility: "nearby",
    myDevice: null,
    lanUrls: [],
    localDaemon: {
      enabled: false,
      platform: "unknown",
      hostname: "",
      autoSaveToDownloads: false,
    },
    peers: [],
    peerSecurity: {},
    transfers: [],
    clipboardItems: [],
    trustedPeerKeys: [],
  });

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("airbridge:theme");
      return saved ? saved === "dark" : false;
    } catch {
      return false;
    }
  });

  const [soundMuted, setSoundMuted] = useState<boolean>(() => {
    try {
      return localStorage.getItem("airbridge:soundMuted") === "1";
    } catch {
      return false;
    }
  });

  const [simulatorOpen, setSimulatorOpen] = useState(false);
  const [setupGuideOpen, setSetupGuideOpen] = useState(false);
  const [clipboardTargetPeer, setClipboardTargetPeer] =
    useState<PeerSummary | null>(null);
  const [stagedFiles, setStagedFiles] = useState<SendableFileInput[]>([]);
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const [toastCopied, setToastCopied] = useState(false);

  useEffect(() => {
    soundMutedRef.current = soundMuted;
    try {
      localStorage.setItem("airbridge:soundMuted", soundMuted ? "1" : "0");
    } catch {
      // ignore
    }
  }, [soundMuted]);

  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("airbridge:theme", darkMode ? "dark" : "light");
    } catch {
      // ignore
    }
  }, [darkMode]);

  const showToast = (notice: ToastNotice) => {
    setToast(notice);
    setToastCopied(false);
  };

  // Initialize WarpClient & PWA Share Target consumer
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("pair") || params.has("shared")) {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
    }

    const client = new WarpClient({
      initialPairCode,
      onIncomingTransfer: () => {
        playIncomingChime(soundMutedRef.current);
      },
      onIncomingClipboard: (item: ClipboardBeamItem) => {
        playIncomingChime(soundMutedRef.current);
        showToast({
          id: item.beamId,
          title: `Clipboard from ${item.peerName}`,
          body:
            item.text.length > 90 ? `${item.text.slice(0, 90)}…` : item.text,
          copyText: item.text,
        });
      },
      onTransferCompleted: (tr) => {
        playTransferCompleteChime(soundMutedRef.current);
        if (tr.direction === "incoming") {
          const savedLocally = tr.receivedFiles.some((f) =>
            Boolean(f.savedToMacPath),
          );
          showToast({
            id: tr.transferId,
            title: savedLocally
              ? "Saved directly to ~/Downloads/AirBridge"
              : `Received ${tr.files.length} file${tr.files.length > 1 ? "s" : ""}`,
            body: `From ${tr.peerName} · Verified SHA-256`,
          });
        }
      },
    });

    clientRef.current = client;
    const unsub = client.subscribe((next) => setSnap(next));
    client
      .start((pubKeyB64) => loadOrCreateDeviceProfile(pubKeyB64))
      .catch(() => {
        setSnap((previous) => ({
          ...previous,
          connectionState: "disconnected",
        }));
        showToast({
          id: "startup-error",
          title: "Could not start secure transfers",
          body: window.isSecureContext
            ? "Refresh the page to reconnect. Your browser needs WebCrypto support."
            : "Open AirBridge over HTTPS on both devices. Plain HTTP on a Wi-Fi IP cannot use browser encryption.",
        });
      });

    // Check if Android Native Share Sheet queued files/text via sw.js
    consumePwaSharedPayload().then((shared) => {
      if (!shared) return;
      if (shared.files.length > 0) {
        setStagedFiles((prev) => [...prev, ...shared.files]);
        showToast({
          id: "pwa-share",
          title: "Shared from Android Share Sheet",
          body: `${shared.files.length} file(s) staged and ready to beam.`,
        });
      }
    });

    return () => {
      unsub();
      client.stop();
      clientRef.current = null;
    };
  }, [initialPairCode]);

  // Global Cmd+V / Ctrl+V screenshot & file paste handler
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const activeTag = (document.activeElement as HTMLElement | null)?.tagName;
      if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
      if (!e.clipboardData) return;

      const files = Array.from(e.clipboardData.files || []);
      if (files.length > 0) {
        e.preventDefault();
        const wrapped = files.map((f) => wrapBrowserFile(f));
        const currentPeers = clientRef.current?.getSnapshot().peers ?? [];
        if (currentPeers.length === 1 && clientRef.current) {
          playBeamSentPulse(soundMutedRef.current);
          clientRef.current.sendFiles(currentPeers[0].peerId, wrapped);
        } else {
          setStagedFiles((prev) => [...prev, ...wrapped]);
          showToast({
            id: `paste-${Date.now()}`,
            title: "Pasted Screenshot / File Staged",
            body: "Select a device on the radar to beam immediately.",
          });
        }
      }
    };

    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const activeIncomingOffer = useMemo(
    () =>
      snap.transfers.find(
        (t) => t.direction === "incoming" && t.status === "pending-accept",
      ) ?? null,
    [snap.transfers],
  );

  const incomingSenderPubKey = useMemo(() => {
    if (!activeIncomingOffer) return undefined;
    return snap.peers.find((p) => p.peerId === activeIncomingOffer.peerId)
      ?.device.publicKey;
  }, [activeIncomingOffer, snap.peers]);

  const handleSendFilesToPeer = (
    peerId: string,
    files: SendableFileInput[],
  ) => {
    if (!clientRef.current || files.length === 0) return;
    playBeamSentPulse(soundMutedRef.current);
    clientRef.current.sendFiles(peerId, files);
  };

  const handleRenameDevice = (newName: string) => {
    saveDeviceName(newName);
    clientRef.current?.updateDeviceName(newName);
  };

  const handleVisibilityChange = (v: VisibilityMode) => {
    clientRef.current?.setVisibility(v);
  };

  return (
    <div className="min-h-screen flex flex-col bg-[var(--ab-bg)] text-[var(--ab-text)] transition-colors">
      <HeaderBar
        connectionState={snap.connectionState}
        visibility={snap.visibility}
        onChangeVisibility={handleVisibilityChange}
        simulatorOpen={simulatorOpen}
        onToggleSimulator={() => setSimulatorOpen((prev) => !prev)}
        onOpenSetupGuide={() => setSetupGuideOpen(true)}
        soundMuted={soundMuted}
        onToggleSound={() => setSoundMuted((prev) => !prev)}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((prev) => !prev)}
      />

      {/* Main Spatial Workspace */}
      <main className="app-main flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-5 sm:py-7">
        {snap.connectionState !== "connected" && (
          <div className="connection-notice" role="status">
            <strong>
              {!window.isSecureContext
                ? "HTTPS is required on your phone"
                : "Connecting to the pairing server…"}
            </strong>
            <p>
              {!window.isSecureContext
                ? "A local Wi-Fi HTTP address can open the page, but cannot start encrypted transfers. Open the same trusted HTTPS address on both devices."
                : "Opening the page is not enough: both devices must connect to the same running AirBridge server. Keep this tab open. If this persists, check that your proxy supports WebSockets at /ws."}
            </p>
            <button onClick={() => window.location.reload()}>
              Retry connection
            </button>
          </div>
        )}
        <div className="page-heading">
          <div>
            <div className="eyebrow">
              A LITTLE LESS FRICTION. A LITTLE MORE FLOW.
            </div>
            <h1>
              Your devices. <span>Better together.</span>
            </h1>
            <p>
              Send anything between Android and Mac. Simply, securely, yours.
            </p>
          </div>
          <span className="network-pill">
            <span />{" "}
            {snap.connectionState === "connected"
              ? "Connected to AirBridge"
              : snap.connectionState === "disconnected"
                ? "Connection unavailable"
                : "Connecting to AirBridge…"}
          </span>
        </div>
        <div
          className={`grid grid-cols-1 gap-5 items-stretch ${
            simulatorOpen
              ? "xl:grid-cols-[1fr_340px_380px] lg:grid-cols-[1fr_360px]"
              : "lg:grid-cols-[1fr_350px]"
          }`}
        >
          <RadarStage
            connectionState={snap.connectionState}
            visibility={snap.visibility}
            myDevice={snap.myDevice}
            localDaemon={snap.localDaemon}
            peers={snap.peers}
            peerSecurity={snap.peerSecurity}
            trustedPeerKeys={snap.trustedPeerKeys}
            stagedFiles={stagedFiles}
            onClearStagedFiles={() => setStagedFiles([])}
            onStageFiles={(files) =>
              setStagedFiles((prev) => [...prev, ...files])
            }
            onSendFilesToPeer={handleSendFilesToPeer}
            onOpenClipboardForPeer={(peer) => setClipboardTargetPeer(peer)}
            onToggleTrustPeer={(pubKey, trusted) =>
              clientRef.current?.toggleTrustedPeer(pubKey, trusted)
            }
            onRenameDevice={handleRenameDevice}
            onOpenSimulator={() => setSimulatorOpen(true)}
          />

          {simulatorOpen && (
            <CompanionSimulator
              open={simulatorOpen}
              hostPairCode={snap.pairCode}
              hostPeerId={snap.peerId}
              onClose={() => setSimulatorOpen(false)}
            />
          )}

          <PairingDock
            pairCode={snap.pairCode}
            lanUrls={snap.lanUrls}
            transfers={snap.transfers}
            clipboardItems={snap.clipboardItems}
            onJoinPairCode={(code) => clientRef.current?.joinPairCode(code)}
            onRotatePairCode={() => clientRef.current?.rotatePairCode()}
            onCancelTransfer={(tid) => clientRef.current?.cancelTransfer(tid)}
          />
        </div>
        <footer className="app-footer">
          <span>
            Built for the devices you love. Not just the ones from the same
            brand.
          </span>
          <a
            href="https://github.com/DigantaDey/android-to-mac"
            target="_blank"
            rel="noreferrer"
          >
            Open source, always ↗
          </a>
          <span>
            PRIVATE BY DESIGN <span className="footer-dot">●</span>
          </span>
        </footer>
      </main>

      {/* Incoming AirDrop Accept / Decline Modal */}
      <TransferModal
        offer={activeIncomingOffer}
        senderPublicKey={incomingSenderPubKey}
        onAccept={(transferId, trustSender) => {
          if (trustSender && incomingSenderPubKey) {
            clientRef.current?.toggleTrustedPeer(incomingSenderPubKey, true);
          }
          clientRef.current?.acceptIncomingTransfer(transferId);
        }}
        onDecline={(transferId) =>
          clientRef.current?.declineIncomingTransfer(transferId)
        }
      />

      {/* Universal Clipboard Modal */}
      <ClipboardModal
        peer={clipboardTargetPeer}
        sasCode={
          clipboardTargetPeer
            ? snap.peerSecurity[clipboardTargetPeer.peerId]?.sasCode
            : undefined
        }
        onClose={() => setClipboardTargetPeer(null)}
        onSendClipboard={async (peerId, text) => {
          if (!clientRef.current) return;
          playBeamSentPulse(soundMutedRef.current);
          await clientRef.current.sendClipboard(peerId, text);
        }}
      />

      {/* Native CLI & Android Share Sheet Setup Modal */}
      <SetupGuideModal
        open={setupGuideOpen}
        onClose={() => setSetupGuideOpen(false)}
      />

      {/* Crisp Floating Toast Notification */}
      {toast && (
        <div className="fixed bottom-5 right-5 z-40 max-w-sm w-[calc(100%-2.5rem)] rounded-2xl ab-elevated shadow-2xl p-4 border border-sky-500/30 flex items-start justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <Sparkles className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[var(--ab-text)]">
                {toast.title}
              </p>
              <p className="text-xs text-[var(--ab-muted)] font-mono-tabular break-all mt-0.5">
                {toast.body}
              </p>
              {toast.copyText && (
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard
                      ?.writeText(toast.copyText!)
                      .catch(() => {});
                    setToastCopied(true);
                    setTimeout(() => setToast(null), 900);
                  }}
                  className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 cursor-pointer"
                >
                  {toastCopied ? (
                    <>
                      <Check className="w-3 h-3" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" />
                      Copy to Clipboard
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="text-[var(--ab-muted)] hover:text-[var(--ab-text)] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
