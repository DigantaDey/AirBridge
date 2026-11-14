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
import { TransferSpeed } from "./components/TransferSpeed.js";
import { TransferModal } from "./components/TransferModal.js";
import { DownloadsModal } from "./components/DownloadsModal.js";
import { ClipboardCenter } from "./components/ClipboardCenter.js";
import { FolderPickerModal } from "./components/FolderPickerModal.js";
import {
  forgetNativeComputer,
  isNativeShell,
  getNativeConnectionContinuity,
  getNativeAccessibilityOptIn,
  isNativeAccessibilityServiceEnabled,
  openNativeAccessibilitySettings,
  isNativeBatteryOptimizationExempt,
  openNativeBatterySettings,
  publishNativeTransferSpeed,
  setNativeAccessibilityOptIn,
  setNativeConnectionContinuity,
  setNativeDarkTheme,
  setNativeTransferActive,
  scanPairingCode,
} from "./engine/nativeShell.js";
import { createAirBridgeClient, type AirBridgeClient } from "./engine/nativeClient.js";
import { ClipboardList, Clock, Download, FolderOpen, Settings } from "lucide-react";

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
  const clientRef = useRef<AirBridgeClient | null>(null);
  const soundMutedRef = useRef<boolean>(false);
  const pendingClipboardWriteRef = useRef<string | null>(null);
  const lastBrowserClipboardRef = useRef<string>("");
  const leftPageRef = useRef<boolean>(false);
  const lastNativeSpeedPublishRef = useRef({ at: 0, active: false });

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
    clipboardReceiveEnabled: true,
  });

  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("airbridge:theme");
      return saved ? saved === "dark" : false;
    } catch {
      return false;
    }
  });

  const [batteryUnrestricted, setBatteryUnrestricted] = useState(isNativeBatteryOptimizationExempt);
  useEffect(() => {
    const refresh = () => setBatteryUnrestricted(isNativeBatteryOptimizationExempt());
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);

  const [stagedFiles, setStagedFiles] = useState<SendableFileInput[]>([]);
  // Received-files folder (host daemon). Only the device running the server
  // can read/change it — the API is loopback-only, so this stays empty on a phone.
  const [receivedFolder, setReceivedFolder] = useState("");
  const [receivedFolderInput, setReceivedFolderInput] = useState("");
  const [folderSaving, setFolderSaving] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  useEffect(() => {
    if (isNativeShell()) return;
    fetch("/api/received-folder")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { downloadDir?: string } | null) => {
        if (j?.downloadDir) { setReceivedFolder(j.downloadDir); setReceivedFolderInput(j.downloadDir); }
      })
      .catch(() => {});
  }, []);
  const openReceivedFolder = (savedPath?: string) => {
    clientRef.current?.openReceivedFolder(savedPath).catch((err: unknown) => {
      showToast({ id: "open-folder", title: "Could not open folder", body: err instanceof Error ? err.message : "Opening folders is only available on the device running AirBridge." });
    });
  };
  const saveReceivedFolder = async () => {
    const next = receivedFolderInput.trim();
    if (!next || !clientRef.current) return;
    setFolderSaving(true);
    try {
      const saved = await clientRef.current.updateReceivedFolder(next);
      setReceivedFolder(saved); setReceivedFolderInput(saved);
      showToast({ id: "folder-saved", title: "Received-files folder updated", body: saved });
    } catch (err) {
      showToast({ id: "folder-save-error", title: "Could not change folder", body: err instanceof Error ? err.message : "Invalid folder path." });
    } finally { setFolderSaving(false); }
  };
  const [toast, setToast] = useState<ToastNotice | null>(null);

  useEffect(() => {
    // The Android shell reserves the real status/nav bar insets in a native
    // parent container and injects a shim; this class keeps CSS from doubling
    // them even before that shim runs.
    document.documentElement.classList.toggle("ab-native-shell", isNativeShell());
  }, []);

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
    // Android draws the status/navigation bars outside the WebView; keep their
    // colour and icon contrast in sync with the in-page theme.
    setNativeDarkTheme(darkMode);
  }, [darkMode]);

  // Keep the desktop daemon's headless clipboard peer in the same pairing
  // group as this browser, even after the tab is closed. The endpoint is
  // loopback-only; Android's shell skips it.
  useEffect(() => {
    if (
      isNativeShell() ||
      !snap.pairCode || !snap.localDaemon.clipboardBridge ||
      typeof fetch !== "function" ||
      import.meta.env.MODE === "test"
    ) return;
    fetch("/api/daemon/background-pair-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairCode: snap.pairCode, autoClipboard: snap.autoClipboardSync, receiveClipboard: snap.clipboardReceiveEnabled }),
    }).catch(() => {});
  }, [snap.pairCode, snap.localDaemon.clipboardBridge, snap.autoClipboardSync, snap.clipboardReceiveEnabled]);

  // The Android foreground service watches the system clipboard even while
  // the WebView is not focused. Feed those changes into the encrypted client.
  useEffect(() => {
    const onNativeClipboard = (raw: string) => {
      const client = clientRef.current;
      if (!client || !client.getSnapshot().autoClipboardSync) return;
      const text = String(raw ?? "");
      if (!text.trim()) return;
      lastBrowserClipboardRef.current = text;
      client.handleDetectedLocalClipboard(text).catch(() => {});
    };
    window.__airbridgeNativeClipboard = onNativeClipboard;
    return () => {
      delete window.__airbridgeNativeClipboard;
    };
  }, []);

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
    lastBrowserClipboardRef.current = text;
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

    const client = createAirBridgeClient({
      initialPairCode,
      onIncomingTransfer: () => {
        playIncomingChime(soundMutedRef.current);
      },

      onIncomingClipboard: (item) => {
        // Honor per-device receive toggle — already filtered in WarpClient, but guard UI echo
        if (!client.getSnapshot().clipboardReceiveEnabled) return;
        const displayText = item.contentType === 'image' && item.imageDataUrl ? `[Image] ${item.imageName || 'image'}` : item.text;
        lastBrowserClipboardRef.current = item.text || '';
        const copyToSystemClipboard = (explicit = false) => {
          // Native snapshots are history, not commands: the service already
          // wrote this beam, possibly while the UI was suspended for minutes.
          if (!explicit && isNativeShell() && window.AirBridgeAndroid?.nativeEngineVersion?.() === 1) return;
          try {
            if (item.contentType === 'image' && item.imageDataUrl) {
              // Images: attempt to write as image if possible, fallback to no-op; keep toast with Save
              pendingClipboardWriteRef.current = null;
              return;
            }
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
            displayText.length > 140
              ? `${displayText.slice(0, 140)}…`
              : displayText,
          actionLabel: item.contentType === 'image' ? 'Save' : 'Copy',
          onAction: () => {
            if (item.contentType === 'image' && item.imageDataUrl) {
              const a = document.createElement('a');
              a.href = item.imageDataUrl;
              a.download = item.imageName || `image-${item.beamId.slice(0,6)}.png`;
              document.body.appendChild(a); a.click(); a.remove();
            } else {
              markLocalCopyHandled(item.text);
              copyToSystemClipboard(true);
            }
            setToast(null);
          },
        });
      },

      onOutgoingAutoClipboard: (item) => {
        lastBrowserClipboardRef.current = item.text || '';
        playBeamSentPulse(soundMutedRef.current);
        const displayText = item.contentType === 'image' && item.imageDataUrl ? `[Image] ${item.imageName || 'image'}` : item.text;
        showToast({
          id: `auto-clip-${item.beamId}`,
          title: `Clipboard beamed to ${item.peerName}`,
          body:
            displayText.length > 140
              ? `${displayText.slice(0, 140)}…`
              : displayText,
        });
      },

      onTransferCompleted: (tr) => {
        playTransferCompleteChime(soundMutedRef.current);
        if (tr.direction === "incoming") {
          const savedToMac = tr.receivedFiles.some((f) => Boolean(f.savedToMacPath));
          const savedToDisk = tr.receivedFiles.some((f) => Boolean(f.savedToDiskPath));
          const savedLocally = savedToMac || savedToDisk;
          const canDownloadInBrowser =
            !savedLocally && tr.receivedFiles.length > 0;
          // Auto-trigger browser download when not saved to disk —
          // removes the extra "go to Recents → Save" step. The toast remains for fallback.
          if (canDownloadInBrowser) {
            // Small delay to let UI render then trigger download
            setTimeout(() => {
              try { saveReceivedTransferFiles(tr); } catch {}
            }, 200);
          }
          const savedPath =
            tr.receivedFiles[0]?.savedToMacPath ||
            tr.receivedFiles[0]?.savedToDiskPath;
          showToast({
            id: tr.transferId,
            title: savedLocally
              ? `Saved to ${savedPath ? savedPath.split('/').slice(-2).join('/') : 'received folder'}`
              : `Received ${tr.files.length} file${tr.files.length > 1 ? "s" : ""} — saved to browser downloads`,
            body: `From ${tr.peerName} · Verified SHA-256`,
            actionLabel: savedToMac
              ? 'Open folder'
              : (canDownloadInBrowser
                ? 'Save again'
                : undefined),
            onAction: savedToMac
              ? () => { openReceivedFolder(tr.receivedFiles[0]?.savedToMacPath); setToast(null); }
              : canDownloadInBrowser
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
          lastBrowserClipboardRef.current = shared.text;
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
          lastBrowserClipboardRef.current = raw;
          if (trimmed) client.markClipboardSynced(raw);
          return;
        }
        if (raw !== lastBrowserClipboardRef.current) {
          lastBrowserClipboardRef.current = raw;
          if (!trimmed) return;
          await client.handleDetectedLocalClipboard(raw);
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
      const candidate = fromData || fromSelection;
      if (candidate.trim()) {
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
    clientRef.current.sendFiles(peerId, files).catch((error: unknown) => {
      showToast({ id: "send-failed", title: "Could not send files", body: error instanceof Error ? error.message : "Reconnect and try again." });
    });
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
  const handleSendClipboardImage = async (peerId: string, dataUrl: string, name?: string) => {
    if (!clientRef.current) throw new Error("Transfer service is not connected yet.");
    await clientRef.current.sendClipboardImage(peerId, dataUrl, name);
  };

  const handleRenameDevice = (newName: string) => {
    saveDeviceName(newName);
    clientRef.current?.updateDeviceName(newName);
  };



  const [pairingOpen, setPairingOpen] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionContinuity, setConnectionContinuity] = useState(getNativeConnectionContinuity);
  const [accessibilityOptIn, setAccessibilityOptIn] = useState(getNativeAccessibilityOptIn);
  const [accessibilityServiceEnabled, setAccessibilityServiceEnabled] = useState(isNativeAccessibilityServiceEnabled);
  const [clipboardOpen, setClipboardOpen] = useState(false);
  const [clipboardPeerId, setClipboardPeerId] = useState<string | null>(null);
  const [clipboardPrefill, setClipboardPrefill] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Let Android's system Back button/gesture close the topmost in-page layer
  // before the shell falls back to WebView history or exits. The same handler
  // powers the Escape key in desktop browsers.
  useEffect(() => {
    const closeTopmostLayer = (): boolean => {
      if (folderPickerOpen) { setFolderPickerOpen(false); return true; }
      if (clipboardOpen) { setClipboardOpen(false); return true; }
      if (activeIncomingOffer) {
        clientRef.current?.declineIncomingTransfer(activeIncomingOffer.transferId);
        return true;
      }
      if (pairingOpen) { setPairingOpen(false); return true; }
      if (downloadsOpen) { setDownloadsOpen(false); return true; }
      if (recentOpen) { setRecentOpen(false); return true; }
      if (settingsOpen) { setSettingsOpen(false); return true; }
      if (showAdvanced) { setShowAdvanced(false); return true; }
      if (toast) { setToast(null); return true; }
      return false;
    };
    window.__airbridgeSystemBack = closeTopmostLayer;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && closeTopmostLayer()) event.preventDefault();
    };
    window.addEventListener("keydown", onEscape);
    return () => {
      delete window.__airbridgeSystemBack;
      window.removeEventListener("keydown", onEscape);
    };
  }, [folderPickerOpen, clipboardOpen, activeIncomingOffer, pairingOpen, downloadsOpen, recentOpen, settingsOpen, showAdvanced, toast]);

  // Android reports the OS Accessibility Service state after the page loads and
  // whenever the user returns from Android Settings. Keep the opt-in UI honest.
  useEffect(() => {
    if (!isNativeShell()) return;
    window.__airbridgeNativeAccessibilityState = (enabled: boolean) => {
      setAccessibilityServiceEnabled(Boolean(enabled));
    };
    return () => {
      delete window.__airbridgeNativeAccessibilityState;
    };
  }, []);

  useEffect(() => {
    if (settingsOpen) setAccessibilityServiceEnabled(isNativeAccessibilityServiceEnabled());
  }, [settingsOpen]);

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
  const hasNativeActiveTransfer = snap.transfers.some((transfer) =>
    transfer.status === "connecting" || transfer.status === "transferring",
  );
  useEffect(() => {
    setNativeTransferActive(hasNativeActiveTransfer);
    return () => { setNativeTransferActive(false); };
  }, [hasNativeActiveTransfer]);

  // The Android shell mirrors the same live rate into its foreground
  // notification. Snapshot updates are frequent, so throttle bridge calls but
  // keep a 1 s heartbeat that also runs when the transfer pauses.
  useEffect(() => {
    const publish = (force = false) => {
      const live = snap.transfers.find(
        (transfer) => transfer.status === "transferring",
      ) ?? null;
      const now = Date.now();
      const previous = lastNativeSpeedPublishRef.current;
      if (!force && live && previous.active && now - previous.at < 500) return;
      lastNativeSpeedPublishRef.current = { at: now, active: Boolean(live) };
      publishNativeTransferSpeed(live);
    };
    publish();
    if (!snap.transfers.some((transfer) => transfer.status === "transferring")) return;
    const timer = window.setInterval(() => publish(true), 1_000);
    return () => window.clearInterval(timer);
  }, [snap.transfers]);

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
          <button
            type="button"
            className="header-action-button"
            aria-label="Clipboard"
            title="Clipboard"
            onClick={() => { setClipboardPeerId(null); setClipboardPrefill(""); setClipboardOpen(true); }}
          >
            <ClipboardList className="header-action-icon" size={16} aria-hidden="true" />
            <span className="header-action-label">Clipboard</span>
            {snap.clipboardItems.length > 0 && (
              <span className="header-count-badge"> ({snap.clipboardItems.length})</span>
            )}
          </button>
          <button
            type="button"
            className="header-action-button"
            aria-label="Recent transfers"
            title="Recent transfers"
            onClick={() => setRecentOpen(true)}
          >
            <Clock className="header-action-icon" size={16} aria-hidden="true" />
            <span className="header-action-label">Recent</span>
            {recentTransfers.length > 0 && (
              <span className="header-count-badge"> ({recentTransfers.length})</span>
            )}
          </button>
          {receivedFolder && (
            <button
              type="button"
              className="header-action-button folder-locate-button"
              aria-label="Open received files folder"
              title={`Open received files folder (${receivedFolder})`}
              onClick={() => openReceivedFolder()}
            >
              <FolderOpen className="header-action-icon" size={16} aria-hidden="true" />
              <span className="header-action-label">Folder</span>
            </button>
          )}
          <button
            type="button"
            className="header-action-button"
            aria-label="Downloads"
            title="Download AirBridge for another device"
            onClick={() => setDownloadsOpen(true)}
          >
            <Download className="header-action-icon" size={16} aria-hidden="true" />
            <span className="header-action-label">Downloads</span>
          </button>
          <button
            type="button"
            className="header-action-button"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="header-action-icon" size={16} aria-hidden="true" />
            <span className="header-action-label">Settings</span>
          </button>
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
                <div><strong>Could not reach the transfer service</strong><p>{snap.connectionError || "Check that AirBridge is running on the same network, then try again."}</p></div>
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
        {activeTransfers.length > 0 && <section className="transfers-section"><div className="section-title"><h2>Transfers</h2><span className="quiet-count">{activeTransfers.length}</span></div>{activeTransfers.map((transfer) => <div className="transfer-row" key={transfer.transferId}><div className="transfer-heading"><strong>{transfer.direction === "incoming" ? `From ${transfer.peerName}` : `To ${transfer.peerName}`}</strong><span className="transfer-heading-state">{transfer.status === "pending-accept" ? "Waiting for approval" : transfer.status === "connecting" ? "Connecting" : "Transferring"}{transfer.status === "transferring" && <TransferSpeed transfer={transfer} showEta className="transfer-speed-badge" />}</span></div><progress value={transfer.totalBytes ? transfer.transferredBytes : 0} max={Math.max(transfer.totalBytes, 1)} aria-label={`Transfer to ${transfer.peerName}`} /><div className="transfer-foot"><span>{formatBytes(transfer.transferredBytes)} of {formatBytes(transfer.totalBytes)}{transfer.status === "transferring" ? <>{" · "}<TransferSpeed transfer={transfer} showEta={false} /></> : ""}</span>{transfer.direction === "outgoing" && <button className="text-button" onClick={() => clientRef.current?.cancelTransfer(transfer.transferId)}>Cancel</button>}</div></div>)}</section>}
        <footer className="utility-footer"><span>Encrypted transfers. No account or cloud storage.</span><button className="text-button" onClick={() => setRecentOpen(true)}>Recent transfers</button></footer>
      </main>
      {pairingOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPairingOpen(false); }}><section className="utility-modal pairing-modal" role="dialog" aria-modal="true" aria-labelledby="pair-title"><div className="modal-heading"><div><p className="section-kicker">PAIR DEVICES</p><h2 id="pair-title">Scan to pair</h2></div><button className="modal-close" aria-label="Close" onClick={() => setPairingOpen(false)}>×</button></div><p className="modal-explainer">Scan this code from AirBridge on your other device. Compare the verification code on both screens before accepting a transfer.</p>{isNativeShell() && <button type="button" className="secondary-button" onClick={() => scanPairingCode()}>Scan with this phone&apos;s camera</button>}<PairingDock pairCode={snap.pairCode} lanUrls={snap.lanUrls} transfers={snap.transfers} clipboardItems={snap.clipboardItems} onJoinPairCode={(code) => clientRef.current?.joinPairCode(code)} onRotatePairCode={() => clientRef.current?.rotatePairCode()} onCancelTransfer={(id) => clientRef.current?.cancelTransfer(id)} onMarkCopied={markLocalCopyHandled} /><button className="text-button advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "Hide network details" : "Having trouble pairing?"}</button>{showAdvanced && <div className="help-copy"><p>Both devices must be running the AirBridge app on the same local network. Guest Wi-Fi and some office networks block device-to-device connections.</p><p>Current service: {snap.connectionState}. {snap.lanUrls.length ? `Local address: ${snap.lanUrls[0]}` : "No local address was reported."}</p></div>}</section></div>}
      {downloadsOpen && <DownloadsModal onClose={() => setDownloadsOpen(false)} />}
      {recentOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecentOpen(false); }}><section className="utility-modal recent-modal" role="dialog" aria-modal="true" aria-labelledby="recent-title"><div className="modal-heading"><div><p className="section-kicker">HISTORY</p><h2 id="recent-title">Recent transfers</h2></div><button className="modal-close" aria-label="Close" onClick={() => setRecentOpen(false)}>×</button></div>{recentTransfers.length ? <div className="recent-list">{recentTransfers.map((transfer) => { const savedMacPath = transfer.receivedFiles.find((f) => f.savedToMacPath)?.savedToMacPath; const savedDiskPath = transfer.receivedFiles.find((f) => f.savedToDiskPath)?.savedToDiskPath; const isSavedToDisk = Boolean(savedMacPath || savedDiskPath); const canSave = transfer.status === "completed" && transfer.direction === "incoming" && transfer.receivedFiles.length > 0 && !isSavedToDisk; return <div className="recent-row" key={transfer.transferId}><span><strong>{transfer.files.map((file) => file.name).join(", ")}</strong><small>{transfer.direction === "incoming" ? "Received" : "Sent"} · {transfer.peerName} · {formatBytes(transfer.totalBytes)} {isSavedToDisk ? "· Saved to folder" : transfer.status === "completed" && transfer.direction === "incoming" ? "· Auto-saved to downloads" : ""}</small></span><span className="recent-actions">{transfer.direction === "incoming" && transfer.status === "completed" && (savedMacPath || receivedFolder) && <button type="button" className="icon-button folder-locate-button" aria-label={`Locate ${transfer.files[0]?.name ?? "received files"} in folder`} title="Locate in received-files folder" onClick={() => openReceivedFolder(savedMacPath)}><FolderOpen size={15} aria-hidden="true" /></button>}{canSave && <button type="button" className="text-button" onClick={() => saveReceivedTransferFiles(transfer)}>{transfer.receivedFiles.length > 1 ? "Save again" : "Save again"}</button>}<span className="recent-state">{transfer.status === "completed" ? "Complete" : transfer.status === "cancelled" ? "Cancelled" : transfer.status === "declined" ? "Declined" : "Failed"}</span></span></div>; })}</div> : <p className="empty-history">Completed transfers will appear here.</p>}</section></div>}
      {settingsOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section className="utility-modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div className="modal-heading"><div><p className="section-kicker">PREFERENCES</p><h2 id="settings-title">Settings</h2></div><button className="modal-close" aria-label="Close" onClick={() => setSettingsOpen(false)}>×</button></div><label className="setting-field">Device name<input defaultValue={deviceName} maxLength={40} onBlur={(event) => { const name = event.target.value.trim(); if (name && name !== deviceName) handleRenameDevice(name); }} /></label>{isNativeShell() && <label className="setting-toggle"><span><strong>Background clipboard &amp; connection</strong><small>{connectionContinuity ? "A native foreground service transfers files and receives clipboard content when you switch apps or turn off the screen. Android may block reading other apps’ clipboards; use Share → AirBridge or the AirBridge selected-text action." : "Opt in to an ongoing notification to keep clipboard sharing and the encrypted session alive while you switch apps."}</small></span><input type="checkbox" checked={connectionContinuity} onChange={(event) => { const enabled = event.target.checked; if (setNativeConnectionContinuity(enabled)) setConnectionContinuity(enabled); }} /></label>}<label className="setting-toggle"><span><strong>Dark appearance</strong><small>Use a monochrome dark theme</small></span><input type="checkbox" checked={darkMode} onChange={() => setDarkMode((value) => !value)} /></label><label className="setting-toggle"><span><strong>Auto-beam copied text</strong><small>{isNativeShell() ? "Beam text when Android permits clipboard access; incoming delivery and explicit Share work without this screen" : snap.localDaemon.clipboardBridge ? "Automatically beam copied text in the background without returning to this page" : "Automatically beam newly copied or shared text to your connected device"}</small></span><input type="checkbox" checked={snap.autoClipboardSync} onChange={(event) => clientRef.current?.setAutoClipboardSync(event.target.checked)} /></label><label className="setting-toggle"><span><strong>Receive clipboard beams</strong><small>{snap.clipboardReceiveEnabled ? "Incoming clipboard text and images are copied by the native service, even without the app screen" : "Blocked — you still beam but won't receive (per-device)"}</small></span><input type="checkbox" checked={snap.clipboardReceiveEnabled} onChange={(event) => clientRef.current?.setClipboardReceiveEnabled(event.target.checked)} /></label>{receivedFolder ? (
            <div className="setting-field received-folder-setting">
              <span><strong>Received files folder</strong></span>
              <small className="received-folder-current" role="button" tabIndex={0} title="Click to browse folders" onClick={() => setFolderPickerOpen(true)} onKeyDown={(e) => { if (e.key === 'Enter') setFolderPickerOpen(true); }}>{receivedFolder} <span className="folder-browse-hint">· Browse…</span></small>
              <span className="received-folder-controls">
                <input aria-label="Received files folder path" value={receivedFolderInput} onChange={(event) => setReceivedFolderInput(event.target.value)} placeholder="~/Downloads/AirBridge or /absolute/path" />
                <button type="button" className="secondary-button" onClick={() => setFolderPickerOpen(true)}>Browse</button>
                <button type="button" className="secondary-button" disabled={folderSaving || !receivedFolderInput.trim() || receivedFolderInput.trim() === receivedFolder} onClick={saveReceivedFolder}>{folderSaving ? "Saving…" : "Save folder"}</button>
                <button type="button" className="icon-button folder-locate-button" aria-label="Open received files folder" title="Open received files folder" onClick={() => openReceivedFolder()}><FolderOpen size={16} aria-hidden="true" /></button>
              </span>
              <small>Click the path or Browse to navigate folders. New received files auto-save here without an extra Save step. Only changeable from this device.</small>
            </div>
          ) : (
            <div className="settings-info"><strong>Received files folder</strong><p>{isNativeShell() ? "Verified files are saved automatically to Downloads/AirBridge by the native service, even when this screen is closed." : "Received files are saved by your browser (auto-download to Downloads folder). On the device running AirBridge you can set an exact folder."}</p>{!isNativeShell() && <div className="received-folder-controls"><input aria-label="Received files folder path" value={receivedFolderInput} onChange={(e) => setReceivedFolderInput(e.target.value)} placeholder="~/Downloads/AirBridge" /><button type="button" className="secondary-button" onClick={() => setFolderPickerOpen(true)}>Browse</button><button type="button" className="secondary-button" disabled={folderSaving || !receivedFolderInput.trim()} onClick={saveReceivedFolder}>{folderSaving ? "Saving…" : "Set folder"}</button></div>}</div>
          )}
          {isNativeShell() && <div className="settings-info"><strong>Background battery access</strong><p>{batteryUnrestricted ? "Android battery optimization is disabled for AirBridge." : "Android battery optimization is enabled. For long screen-off transfers, choose AirBridge → Unrestricted or Don’t optimize in Android’s battery settings."} The native service keeps transfers independent of this screen; some manufacturers also require allowing background activity or auto-start. Force-stop and Android’s Stop action still end the service.</p><button type="button" className="secondary-button" onClick={() => openNativeBatterySettings()}>Open battery settings</button></div>}{isNativeShell() && <div className="settings-info accessibility-settings"><strong>Accessibility-assisted clipboard capture</strong><p>Off by default. Android 10+ can hide clipboard changes from background apps. Opting in lets AirBridge watch for copy and selection events through a service you enable in Android Settings, then beam plain text to your paired computer while this screen is hidden. AirBridge cannot enable the service for you, never reads other apps' text fields or keystrokes, and Android may still block hidden clipboard reads. Accessibility is not a clipboard-permission bypass. If a copy is blocked, use Share → AirBridge or select text → AirBridge in the other app.</p><label className="setting-toggle"><span><strong>Use Accessibility Service for hidden clipboard</strong><small>{accessibilityOptIn ? "Opted in. " : "Off. "}{accessibilityServiceEnabled ? "Service enabled in Android Settings." : "Service not enabled yet — open Android Settings below."}</small></span><input type="checkbox" checked={accessibilityOptIn} onChange={(event) => { const enabled = event.target.checked; if (setNativeAccessibilityOptIn(enabled)) { setAccessibilityOptIn(enabled); if (enabled && !accessibilityServiceEnabled) openNativeAccessibilitySettings(); } }} /></label><p className="accessibility-status" aria-live="polite"><strong>Android Settings:</strong> {accessibilityServiceEnabled ? "AirBridge clipboard bridge is enabled." : "AirBridge clipboard bridge is not enabled."}</p><button type="button" className="secondary-button" onClick={() => openNativeAccessibilitySettings()}>Open Accessibility settings</button></div>}<div className="settings-info"><strong>About connection status</strong><p>“Running” means this app is connected to its transfer service. “Nearby” means another device was discovered; a secure session is only ready after pairing completes.</p></div><div className="settings-info"><strong>Privacy and consent</strong><p>Incoming transfers ask before saving. Auto-accept is off. Revoke trusted devices in advanced trust management.</p></div>{isNativeShell() && <div className="settings-info"><strong>Paired computer</strong><p>The UI is bundled with this app. The native service connects to your paired computer independently of this screen. Changing computers ends active transfers and starts a fresh pairing.</p><button type="button" className="secondary-button" onClick={() => forgetNativeComputer()}>Change computer</button></div>}<a className="text-button advanced-toggle" href="https://github.com/DigantaDey/AirBridge#android-background-behavior" target="_blank" rel="noreferrer">About this version</a></section></div>}
      <TransferModal offer={activeIncomingOffer} senderPublicKey={incomingSenderPubKey} onAccept={(transferId, trustSender) => { if (trustSender && incomingSenderPubKey) clientRef.current?.toggleTrustedPeer(incomingSenderPubKey, true); clientRef.current?.acceptIncomingTransfer(transferId).catch((error: unknown) => showToast({ id: "accept-error", title: "Could not accept transfer", body: error instanceof Error ? error.message : "Try accepting the offer again." })); }} onDecline={(transferId) => { clientRef.current?.declineIncomingTransfer(transferId).catch(() => {}); }} />
      {clipboardOpen && <ClipboardCenter peers={snap.peers} items={snap.clipboardItems} autoSync={snap.autoClipboardSync} hostClipboardActive={Boolean(snap.localDaemon.clipboardBridge)} receiveEnabled={snap.clipboardReceiveEnabled} initialPeerId={clipboardPeerId} prefill={clipboardPrefill} onToggleAutoSync={(enabled) => clientRef.current?.setAutoClipboardSync(enabled)} onToggleReceive={(enabled) => clientRef.current?.setClipboardReceiveEnabled(enabled)} onMarkCopied={markLocalCopyHandled} onSend={handleSendClipboard} onSendImage={handleSendClipboardImage} onClose={() => setClipboardOpen(false)} />}
      {folderPickerOpen && <FolderPickerModal initialPath={receivedFolder || receivedFolderInput || ''} onSelect={(p) => { setReceivedFolderInput(p); setFolderPickerOpen(false); }} onClose={() => setFolderPickerOpen(false)} />}
      {toast && <div className="utility-toast" role="status"><strong>{toast.title}</strong><span>{toast.body}</span>{toast.actionLabel && <button type="button" className="toast-action" onClick={toast.onAction}>{toast.actionLabel}</button>}<button aria-label="Dismiss notification" onClick={() => setToast(null)}>×</button></div>}
    </div>
  );
}
