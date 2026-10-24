import { useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "../shared/protocol.js";
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
  type SendableFileInput,
  type TransferSessionView,
  type WarpClientSnapshot,
  wrapBrowserFile,
} from "./engine/warpClient.js";
import {
  consumePwaSharedPayload,
  triggerBatchZipDownload,
  triggerSingleFileDownload,
} from "./engine/fileDropUtils.js";
import { PairingDock } from "./components/PairingDock.js";
import { TransferModal } from "./components/TransferModal.js";
import { ClipboardCenter } from "./components/ClipboardCenter.js";

interface ToastNotice {
  id: string;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
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
  const pendingClipboardWriteRef = useRef<string | null>(null);
  const lastBrowserClipboardRef = useRef<string>("");
  const leftPageRef = useRef<boolean>(false);

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
    autoClipboardSync: true,
  });

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("airbridge:theme");
      return saved ? saved === "dark" : false;
    } catch {
      return false;
    }
  });

  const [stagedFiles, setStagedFiles] = useState<SendableFileInput[]>([]);
  const [toast, setToast] = useState<ToastNotice | null>(null);

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
  };

  const saveReceivedTransferFiles = (tr: TransferSessionView) => {
    if (tr.receivedFiles.length === 1) {
      triggerSingleFileDownload(tr.receivedFiles[0]);
    } else if (tr.receivedFiles.length > 1) {
      triggerBatchZipDownload(
        tr.receivedFiles,
        `AirBridge-${tr.peerName.replace(/\s+/g, "-")}`,
      );
    }
  };

  const markLocalCopyHandled = (text: string) => {
    lastBrowserClipboardRef.current = text.trim();
    clientRef.current?.markClipboardSynced(text);
  };

  // Initialize WarpClient & PWA Share Target consumer
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (
      params.has("pair") ||
      params.has("shared") ||
      params.has("share_error")
    ) {
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, "", cleanUrl);
    }
    if (params.has("share_error")) {
      showToast({
        id: "share-error",
        title: "Could not import shared item",
        body: "The shared content was not readable here. Try choosing the file inside AirBridge instead.",
      });
    }

    const client = new WarpClient({
      initialPairCode,
      onIncomingTransfer: () => {
        playIncomingChime(soundMutedRef.current);
      },

      onIncomingClipboard: (item) => {
        lastBrowserClipboardRef.current = item.text.trim();
        const copyToSystemClipboard = () => {
          try {
            const p = navigator.clipboard?.writeText(item.text);
            if (p) {
              p.then(() => {
                if (pendingClipboardWriteRef.current === item.text) {
                  pendingClipboardWriteRef.current = null;
                }
              }).catch(() => {
                pendingClipboardWriteRef.current = item.text;
              });
            } else {
              pendingClipboardWriteRef.current = item.text;
            }
          } catch {
            pendingClipboardWriteRef.current = item.text;
          }
        };
        copyToSystemClipboard();
        showToast({
          id: `clip-${item.beamId}`,
          title: `Clipboard from ${item.peerName}`,
          body:
            item.text.length > 140
              ? `${item.text.slice(0, 140)}…`
              : item.text,
          actionLabel: "Copy",
          onAction: () => {
            markLocalCopyHandled(item.text);
            copyToSystemClipboard();
            setToast(null);
          },
        });
      },

      onOutgoingAutoClipboard: (item) => {
        lastBrowserClipboardRef.current = item.text.trim();
        playBeamSentPulse(soundMutedRef.current);
        showToast({
          id: `auto-clip-${item.beamId}`,
          title: `Clipboard beamed to ${item.peerName}`,
          body:
            item.text.length > 140
              ? `${item.text.slice(0, 140)}…`
              : item.text,
        });
      },

      onTransferCompleted: (tr) => {
        playTransferCompleteChime(soundMutedRef.current);
        if (tr.direction === "incoming") {
          const savedLocally = tr.receivedFiles.some((f) =>
            Boolean(f.savedToMacPath),
          );
          const canDownloadInBrowser =
            !savedLocally && tr.receivedFiles.length > 0;
          showToast({
            id: tr.transferId,
            title: savedLocally
              ? "Saved directly to ~/Downloads/AirBridge"
              : `Received ${tr.files.length} file${tr.files.length > 1 ? "s" : ""}`,
            body: `From ${tr.peerName} · Verified SHA-256`,
            actionLabel: canDownloadInBrowser
              ? tr.receivedFiles.length > 1
                ? "Save ZIP"
                : "Save"
              : undefined,
            onAction: canDownloadInBrowser
              ? () => {
                  saveReceivedTransferFiles(tr);
                  setToast(null);
                }
              : undefined,
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
      if (shared.text) {
        if (client.getSnapshot().autoClipboardSync) {
          lastBrowserClipboardRef.current = shared.text.trim();
          client
            .handleDetectedLocalClipboard(shared.text)
            .then((sent) => {
              if (sent.length === 0) {
                showToast({
                  id: "pwa-share-clip",
                  title: "Beaming shared text…",
                  body: "Will beam automatically as soon as your paired device connects.",
                });
              }
            })
            .catch(() => {});
        } else {
          setClipboardPrefill(shared.text);
          setClipboardPeerId(null);
          setClipboardOpen(true);
        }
      }
    });

    return () => {
      unsub();
      client.stop();
      clientRef.current = null;
    };
  }, [initialPairCode]);

  // Browser-side automatic clipboard sync & deferred incoming clipboard flush
  useEffect(() => {
    const queryClipboardReadPermission = async (): Promise<
      "granted" | "prompt" | "denied" | "unknown"
    > => {
      try {
        if (!navigator.permissions?.query) return "unknown";
        const status = await navigator.permissions.query({
          name: "clipboard-read" as PermissionName,
        });
        return status.state;
      } catch {
        return "unknown";
      }
    };

    const flushPendingIncomingClipboard = (): boolean => {
      const pending = pendingClipboardWriteRef.current;
      if (!pending || !navigator.clipboard?.writeText) return false;
      try {
        navigator.clipboard
          .writeText(pending)
          .then(() => {
            if (pendingClipboardWriteRef.current === pending) {
              pendingClipboardWriteRef.current = null;
            }
          })
          .catch(() => {});
        return true;
      } catch {
        return false;
      }
    };

    const syncBrowserClipboard = async (
      mode: "seed" | "return" | "poll",
    ): Promise<void> => {
      const client = clientRef.current;
      if (!client || !client.getSnapshot().autoClipboardSync) return;
      if (pendingClipboardWriteRef.current) {
        flushPendingIncomingClipboard();
        return;
      }
      if (!navigator.clipboard?.readText) return;

      const perm = await queryClipboardReadPermission();
      if (perm === "denied") return;
      if ((mode === "seed" || mode === "poll") && perm !== "granted") {
        return;
      }

      try {
        const raw = await navigator.clipboard.readText();
        const trimmed = raw.trim();
        if (mode === "seed" && !leftPageRef.current) {
          lastBrowserClipboardRef.current = trimmed;
          if (trimmed) client.markClipboardSynced(trimmed);
          return;
        }
        if (trimmed && trimmed !== lastBrowserClipboardRef.current) {
          lastBrowserClipboardRef.current = trimmed;
          await client.handleDetectedLocalClipboard(trimmed);
        }
      } catch {
        // Ignore NotAllowedError when unfocused or permission not granted
      }
    };

    syncBrowserClipboard("seed").catch(() => {});

    const onCopyOrCut = (event: ClipboardEvent) => {
      const client = clientRef.current;
      if (!client || !client.getSnapshot().autoClipboardSync) return;
      const activeEl = document.activeElement;
      if (
        activeEl instanceof HTMLInputElement &&
        activeEl.type === "password"
      ) {
        return;
      }
      const fromData = event.clipboardData?.getData("text/plain") || "";
      const fromSelection = window.getSelection?.()?.toString() || "";
      const candidate = (fromData || fromSelection).trim();
      if (candidate) {
        lastBrowserClipboardRef.current = candidate;
        client.handleDetectedLocalClipboard(candidate).catch(() => {});
        return;
      }
      window.setTimeout(() => {
        syncBrowserClipboard("return").catch(() => {});
      }, 40);
    };

    const onBlur = () => {
      leftPageRef.current = true;
    };

    const onFocus = () => {
      if (flushPendingIncomingClipboard()) return;
      if (leftPageRef.current) {
        syncBrowserClipboard("return").catch(() => {});
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        leftPageRef.current = true;
      } else if (document.visibilityState === "visible") {
        if (flushPendingIncomingClipboard()) return;
        if (leftPageRef.current) {
          syncBrowserClipboard("return").catch(() => {});
        }
      }
    };

    const onUserInteraction = () => {
      flushPendingIncomingClipboard();
    };

    document.addEventListener("copy", onCopyOrCut);
    document.addEventListener("cut", onCopyOrCut);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pointerdown", onUserInteraction);
    window.addEventListener("touchstart", onUserInteraction, { passive: true });
    window.addEventListener("keydown", onUserInteraction);

    // On devices without the loopback OS clipboard daemon (e.g. Android in
    // split-screen or foreground with clipboard-read permission granted),
    // gently check for newly copied text.
    const pollTimer = snap.localDaemon.clipboardBridge
      ? null
      : window.setInterval(() => {
          syncBrowserClipboard("poll").catch(() => {});
        }, 1200);

    return () => {
      document.removeEventListener("copy", onCopyOrCut);
      document.removeEventListener("cut", onCopyOrCut);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointerdown", onUserInteraction);
      window.removeEventListener("touchstart", onUserInteraction);
      window.removeEventListener("keydown", onUserInteraction);
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, [snap.localDaemon.clipboardBridge]);

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

  const openClipboardForPeer = (peerId: string) => {
    setClipboardPeerId(peerId);
    setClipboardPrefill("");
    setClipboardOpen(true);
  };

  const handleSendClipboard = async (peerId: string, text: string) => {
    if (!clientRef.current) {
      throw new Error("Transfer service is not connected yet.");
    }
    await clientRef.current.sendClipboard(peerId, text);
  };

  const handleRenameDevice = (newName: string) => {
    saveDeviceName(newName);
    clientRef.current?.updateDeviceName(newName);
  };



  const [pairingOpen, setPairingOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [clipboardPeerId, setClipboardPeerId] = useState<string | null>(null);
  const [clipboardPrefill, setClipboardPrefill] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const filePicker = useRef<HTMLInputElement>(null);
  const deviceName = snap.myDevice?.name || "This device";
  const connectionLabel = snap.connectionState === "connected"
    ? "Transfer service connected"
    : snap.connectionState === "reconnecting"
      ? "Reconnecting to transfer service"
      : snap.connectionState === "disconnected"
        ? "Transfer service unavailable"
        : "Starting transfer service";
  const stageFiles = (files: FileList | File[]) => {
    // Snapshot the live FileList SYNCHRONOUSLY. The file input resets its
    // value ("") right after the change event, which empties the same FileList
    // object in real browsers — a deferred React state updater reading it later
    // would then see zero files, so nothing would stage and Send stayed
    // disabled. Capturing wrapped File references first avoids that race.
    const wrapped = Array.from(files).map((file) => wrapBrowserFile(file));
    setStagedFiles((current) => [...current, ...wrapped]);
  };
  const activeTransfers = snap.transfers.filter((transfer) =>
    ["connecting", "transferring", "pending-accept"].includes(transfer.status),
  );
  const recentTransfers = useMemo(
    () =>
      snap.transfers
        .filter(
          (transfer) =>
            !["connecting", "transferring", "pending-accept"].includes(
              transfer.status,
            ),
        )
        .sort(
          (a, b) =>
            (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt),
        ),
    [snap.transfers],
  );

  return (
    <div className="utility-shell">
      <header className="utility-header">
        <div className="brand"><span className="brand-mark">A</span><span>AirBridge</span></div>
        <div className="header-actions">
          <button className="quiet-button" onClick={() => { setClipboardPeerId(null); setClipboardPrefill(""); setClipboardOpen(true); }}>
            Clipboard{snap.clipboardItems.length > 0 ? ` (${snap.clipboardItems.length})` : ""}
          </button>
          <button className="quiet-button" onClick={() => setRecentOpen(true)}>
            Recent{recentTransfers.length > 0 ? ` (${recentTransfers.length})` : ""}
          </button>
          <button className="icon-button" aria-label="Settings" title="Settings" onClick={() => setSettingsOpen(true)}>Settings</button>
        </div>
      </header>
      <main className="utility-main">
        <section className="device-heading">
          <div>
            <p className="section-kicker">YOUR DEVICE</p>
            <h1>{deviceName}</h1>
          </div>
          <div className="service-state" role="status"><span className="state-symbol" aria-hidden="true">{snap.connectionState === "connected" ? "●" : "○"}</span><span>{connectionLabel}</span></div>
        </section>
        {snap.connectionState !== "connected" && (
          <div className="recovery-note" role="status">
            {!window.isSecureContext ? (
              <>
                <div>
                  <strong>Secure connection required</strong>
                  <p>
                    Browsers only enable AirBridge&apos;s encryption on HTTPS or localhost
                    pages, so this plain-HTTP Wi-Fi address can&apos;t start transfers. The
                    AirBridge server serves HTTPS on this same address and port — switch to it:
                  </p>
                  <p>
                    First visit only: if the browser says the certificate isn&apos;t trusted
                    yet, install AirBridge&apos;s local CA from{" "}
                    <code>{`http://${window.location.host}/airbridge-ca.crt`}</code> (Android:
                    Settings → Security → Install a certificate → CA certificate) and check its
                    SHA-256 fingerprint matches the one printed where AirBridge is running on
                    the Mac, then reload the secure address.
                  </p>
                </div>
                <button
                  className="text-button"
                  onClick={() => {
                    const pair = initialPairCode ? `?pair=${encodeURIComponent(initialPairCode)}` : "";
                    window.location.href = `https://${window.location.host}/${pair}`;
                  }}
                >
                  Open secure (HTTPS) address
                </button>
              </>
            ) : (
              <>
                <div><strong>Could not reach the transfer service</strong><p>Check that AirBridge is running on the same network, then try again.</p></div>
                <button className="text-button" onClick={() => window.location.reload()}>Try again</button>
              </>
            )}
          </div>
        )}
        <section className="devices-section">
          <div className="section-title"><h2>Devices</h2><button className="text-button" onClick={() => setPairingOpen(true)}>Pair a device</button></div>
          {snap.peers.length ? <ul className="device-list">{snap.peers.map((peer) => {
            const verification = snap.peerSecurity[peer.peerId];
            return <li className="device-row" key={peer.peerId}>
              <span className="device-glyph" aria-hidden="true">{peer.device.formFactor === "phone" ? "▯" : "▱"}</span>
              <span className="device-copy"><strong>{peer.device.name}</strong><small>{peer.discoveryScope === "paired" ? "Paired" : "Nearby"}{verification ? " · Encrypted session established" : " · Discovered; pair to send"}</small></span>
              <button className="quiet-button clipboard-device-button" aria-label={`Send clipboard text to ${peer.device.name}`} title="Send text / link / code" onClick={() => openClipboardForPeer(peer.peerId)}>Clipboard</button>
              <button className="send-device-button" disabled={stagedFiles.length === 0 || !verification} onClick={() => { handleSendFilesToPeer(peer.peerId, stagedFiles); setStagedFiles([]); }}>Send</button>
            </li>;
          })}</ul> : <div className="empty-devices"><p>No devices found yet</p><span>Open AirBridge on your other device on the same Wi-Fi network, or pair it with a QR code.</span><button className="secondary-button" onClick={() => setPairingOpen(true)}>Pair with QR code</button></div>}
        </section>
        <section className="send-section">
          <div className="section-title"><h2>Send files</h2>{stagedFiles.length > 0 && <button className="text-button" onClick={() => setStagedFiles([])}>Clear selection</button>}</div>
          <div className={`drop-area ${dragging ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); stageFiles(event.dataTransfer.files); }}>
            <input ref={filePicker} type="file" multiple className="visually-hidden" onChange={(event) => { if (event.target.files) stageFiles(event.target.files); event.target.value = ""; }} aria-label="Choose files to send" />
            <span className="upload-symbol" aria-hidden="true">↑</span>
            <p><strong>Drop files here</strong><span> or </span><button className="inline-button" onClick={() => filePicker.current?.click()}>choose files</button></p>
            <small>Files stay between your devices. The receiver must accept each transfer.</small>
          </div>
          {stagedFiles.length > 0 && <ul className="staged-list" aria-label="Selected files">{stagedFiles.map((file, index) => <li key={`${file.name}-${index}`}><span>{file.name}</span><small>{formatBytes(file.size)}</small><button className="remove-file" aria-label={`Remove ${file.name}`} onClick={() => setStagedFiles((files) => files.filter((_, itemIndex) => itemIndex !== index))}>×</button></li>)}</ul>}
          {stagedFiles.length > 0 && <p className="selection-hint">{stagedFiles.length} file{stagedFiles.length === 1 ? "" : "s"} selected. Choose a ready device above to send.</p>}
        </section>
        {activeTransfers.length > 0 && <section className="transfers-section"><div className="section-title"><h2>Transfers</h2><span className="quiet-count">{activeTransfers.length}</span></div>{activeTransfers.map((transfer) => <div className="transfer-row" key={transfer.transferId}><div className="transfer-heading"><strong>{transfer.direction === "incoming" ? `From ${transfer.peerName}` : `To ${transfer.peerName}`}</strong><span>{transfer.status === "pending-accept" ? "Waiting for approval" : transfer.status === "connecting" ? "Connecting" : "Transferring"}</span></div><progress value={transfer.totalBytes ? transfer.transferredBytes : 0} max={Math.max(transfer.totalBytes, 1)} aria-label={`Transfer to ${transfer.peerName}`} /><div className="transfer-foot"><span>{formatBytes(transfer.transferredBytes)} of {formatBytes(transfer.totalBytes)}</span>{transfer.direction === "outgoing" && <button className="text-button" onClick={() => clientRef.current?.cancelTransfer(transfer.transferId)}>Cancel</button>}</div></div>)}</section>}
        <footer className="utility-footer"><span>Encrypted transfers. No account or cloud storage.</span><button className="text-button" onClick={() => setRecentOpen(true)}>Recent transfers</button></footer>
      </main>
      {pairingOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPairingOpen(false); }}><section className="utility-modal pairing-modal" role="dialog" aria-modal="true" aria-labelledby="pair-title"><div className="modal-heading"><div><p className="section-kicker">PAIR DEVICES</p><h2 id="pair-title">Scan to pair</h2></div><button className="modal-close" aria-label="Close" onClick={() => setPairingOpen(false)}>×</button></div><p className="modal-explainer">Scan this code from AirBridge on your other device. Compare the verification code on both screens before accepting a transfer.</p><PairingDock pairCode={snap.pairCode} lanUrls={snap.lanUrls} transfers={snap.transfers} clipboardItems={snap.clipboardItems} onJoinPairCode={(code) => clientRef.current?.joinPairCode(code)} onRotatePairCode={() => clientRef.current?.rotatePairCode()} onCancelTransfer={(id) => clientRef.current?.cancelTransfer(id)} onMarkCopied={markLocalCopyHandled} /><button className="text-button advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "Hide network details" : "Having trouble pairing?"}</button>{showAdvanced && <div className="help-copy"><p>Both devices must be running the AirBridge app on the same local network. Guest Wi-Fi and some office networks block device-to-device connections.</p><p>Current service: {snap.connectionState}. {snap.lanUrls.length ? `Local address: ${snap.lanUrls[0]}` : "No local address was reported."}</p></div>}</section></div>}
      {recentOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecentOpen(false); }}><section className="utility-modal recent-modal" role="dialog" aria-modal="true" aria-labelledby="recent-title"><div className="modal-heading"><div><p className="section-kicker">HISTORY</p><h2 id="recent-title">Recent transfers</h2></div><button className="modal-close" aria-label="Close" onClick={() => setRecentOpen(false)}>×</button></div>{recentTransfers.length ? <div className="recent-list">{recentTransfers.map((transfer) => { const canSave = transfer.status === "completed" && transfer.direction === "incoming" && transfer.receivedFiles.length > 0; return <div className="recent-row" key={transfer.transferId}><span><strong>{transfer.files.map((file) => file.name).join(", ")}</strong><small>{transfer.direction === "incoming" ? "Received" : "Sent"} · {transfer.peerName} · {formatBytes(transfer.totalBytes)}</small></span><span className="recent-actions">{canSave && <button type="button" className="text-button" onClick={() => saveReceivedTransferFiles(transfer)}>{transfer.receivedFiles.length > 1 ? "Save ZIP" : "Save"}</button>}<span className="recent-state">{transfer.status === "completed" ? "Complete" : transfer.status === "cancelled" ? "Cancelled" : transfer.status === "declined" ? "Declined" : "Failed"}</span></span></div>; })}</div> : <p className="empty-history">Completed transfers will appear here.</p>}</section></div>}
      {settingsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="utility-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-heading"><div><p className="section-kicker">PREFERENCES</p><h2 id="settings-title">Settings</h2></div><button className="modal-close" aria-label="Close" onClick={() => setSettingsOpen(false)}>×</button></div><label className="setting-field">Device name<input defaultValue={deviceName} maxLength={40} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== deviceName) handleRenameDevice(name); }} /></label><label className="setting-toggle"><span><strong>Dark appearance</strong><small>Use a monochrome dark theme</small></span><input type="checkbox" checked={darkMode} onChange={() => setDarkMode((value) => !value)} /></label><label className="setting-toggle"><span><strong>Auto-beam copied text</strong><small>{snap.localDaemon.clipboardBridge ? "Automatically beam copied text in the background without returning to this page" : "Automatically beam newly copied or shared text to your connected device"}</small></span><input type="checkbox" checked={snap.autoClipboardSync} onChange={(event) => clientRef.current?.setAutoClipboardSync(event.target.checked)} /></label><div className="settings-info"><strong>About connection status</strong><p>“Running” means this app is connected to its transfer service. “Nearby” means another device was discovered; a secure session is only ready after pairing completes.</p></div><div className="settings-info"><strong>Privacy and consent</strong><p>Incoming transfers ask before saving. Auto-accept is off. Revoke trusted devices in advanced trust management.</p></div><a className="text-button advanced-toggle" href="https://github.com/DigantaDey/android-to-mac#important-current-product-limits" target="_blank" rel="noreferrer">About this version</a></section></div>}
      <TransferModal offer={activeIncomingOffer} senderPublicKey={incomingSenderPubKey} onAccept={(transferId, trustSender) => { if (trustSender && incomingSenderPubKey) clientRef.current?.toggleTrustedPeer(incomingSenderPubKey, true); clientRef.current?.acceptIncomingTransfer(transferId); }} onDecline={(transferId) => clientRef.current?.declineIncomingTransfer(transferId)} />
      {clipboardOpen && <ClipboardCenter peers={snap.peers} items={snap.clipboardItems} autoSync={snap.autoClipboardSync} hostClipboardActive={Boolean(snap.localDaemon.clipboardBridge)} initialPeerId={clipboardPeerId} prefill={clipboardPrefill} onToggleAutoSync={(enabled) => clientRef.current?.setAutoClipboardSync(enabled)} onMarkCopied={markLocalCopyHandled} onSend={handleSendClipboard} onClose={() => setClipboardOpen(false)} />}
      {toast && <div className="utility-toast" role="status"><strong>{toast.title}</strong><span>{toast.body}</span>{toast.actionLabel && <button type="button" className="toast-action" onClick={toast.onAction}>{toast.actionLabel}</button>}<button aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button></div>}
    </div>
  );
}
