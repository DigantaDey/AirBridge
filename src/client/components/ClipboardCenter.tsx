import { useEffect, useRef, useState } from "react";
import type { PeerSummary } from "../../shared/protocol.js";
import type { ClipboardBeamItem } from "../engine/warpClient.js";

interface ClipboardCenterProps {
  peers: PeerSummary[];
  items: ClipboardBeamItem[];
  autoSync: boolean;
  hostClipboardActive: boolean;
  /** Preselect this peer when opened from a device row. */
  initialPeerId?: string | null;
  /** Text shared via the Android Share Sheet arrives prefilled. */
  prefill?: string;
  onToggleAutoSync: (enabled: boolean) => void;
  onMarkCopied?: (text: string) => void;
  onSend: (peerId: string, text: string) => Promise<void>;
  onClose: () => void;
}

function formatTimestamp(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

export function ClipboardCenter({
  peers,
  items,
  autoSync,
  hostClipboardActive,
  initialPeerId,
  prefill,
  onToggleAutoSync,
  onMarkCopied,
  onSend,
  onClose,
}: ClipboardCenterProps) {
  const [text, setText] = useState(prefill ?? "");
  const [peerId, setPeerId] = useState<string>(
    initialPeerId && peers.some((p) => p.peerId === initialPeerId)
      ? initialPeerId
      : (peers[0]?.peerId ?? ""),
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedBeamId, setCopiedBeamId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Peers can arrive after the modal opened (e.g. right after the Share Sheet
  // redirected in). Keep the destination select on a valid value.
  useEffect(() => {
    if (!peerId && peers[0]) {
      setPeerId(peers[0].peerId);
    }
  }, [peers, peerId]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handlePasteFromSystem = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) setText(clip);
    } catch {
      setError(
        "The browser blocked clipboard access — paste manually with Ctrl/⌘+V.",
      );
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !peerId || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(peerId, trimmed);
      setText("");
      textareaRef.current?.focus();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not beam this text.",
      );
    } finally {
      setSending(false);
    }
  };

  const copyItem = (item: ClipboardBeamItem) => {
    onMarkCopied?.(item.text);
    try {
      navigator.clipboard?.writeText(item.text).catch(() => {});
    } catch {
      // ignore — user can still select the text manually
    }
    setCopiedBeamId(item.beamId);
    window.setTimeout(() => {
      setCopiedBeamId((current) => (current === item.beamId ? null : current));
    }, 1500);
  };

  const canSend = text.trim().length > 0 && Boolean(peerId) && !sending;

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="utility-modal clipboard-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="clipboard-title"
      >
        <div className="modal-heading">
          <div>
            <p className="section-kicker">UNIVERSAL CLIPBOARD</p>
            <h2 id="clipboard-title">Copy-paste between devices</h2>
          </div>
          <button
            type="button"
            className="modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p className="modal-explainer">
          Text, links, OTP codes and snippets are end-to-end encrypted (the same
          AES-256-GCM session as file transfers). Incoming text is copied to this
          device&apos;s clipboard automatically.
        </p>

        <label className="setting-toggle clipboard-auto-toggle">
          <span>
            <strong>Auto-beam copied text</strong>
            <small>
              {hostClipboardActive
                ? "Copies anywhere on this computer beam automatically in the background without returning to this page."
                : "Automatically beam newly copied or shared text to your connected device."}
            </small>
          </span>
          <input
            type="checkbox"
            checked={autoSync}
            onChange={(event) => onToggleAutoSync(event.target.checked)}
          />
        </label>

        <form className="clipboard-compose" onSubmit={handleSubmit}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            placeholder="Paste a link, 2FA code, Wi-Fi password, command…"
            aria-label="Text to send to the other device"
          />
          {error && <p className="clipboard-error" role="alert">{error}</p>}
          <div className="clipboard-actions">
            <div className="clipboard-destination">
              <label htmlFor="clipboard-peer">To</label>
              <select
                id="clipboard-peer"
                value={peerId}
                onChange={(event) => setPeerId(event.target.value)}
                disabled={peers.length === 0}
              >
                {peers.length === 0 ? (
                  <option value="">No device found yet</option>
                ) : (
                  peers.map((peer) => (
                    <option key={peer.peerId} value={peer.peerId}>
                      {peer.device.name}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="clipboard-buttons">
              <button
                type="button"
                className="quiet-button"
                onClick={handlePasteFromSystem}
              >
                Paste from this device
              </button>
              <button
                type="submit"
                className="beam-button"
                disabled={!canSend}
              >
                {sending ? "Beaming…" : "Beam text"}
              </button>
            </div>
          </div>
        </form>

        <div className="clipboard-history">
          <div className="section-title">
            <h2>Recent clipboard beams</h2>
            <span className="quiet-count">{items.length}</span>
          </div>
          {items.length === 0 ? (
            <p className="clipboard-empty">
              Beamed text will appear here. Send an OTP or a link from one device
              and paste it straight into an app on the other.
            </p>
          ) : (
            <ul className="clipboard-list">
              {items.map((item) => (
                <li key={item.beamId} className="clipboard-item">
                  <div className="clipboard-item-meta">
                    <span>
                      {item.direction === "incoming" ? "From" : "To"}{" "}
                      {item.peerName} · {formatTimestamp(item.timestamp)}
                    </span>
                    <span className="clipboard-badge">{item.contentType}</span>
                  </div>
                  <pre>{item.text}</pre>
                  <div className="clipboard-item-actions">
                    {item.contentType === "url" && (
                      <a
                        className="text-button"
                        href={item.text}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Open URL
                      </a>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => copyItem(item)}
                    >
                      {copiedBeamId === item.beamId ? "Copied ✓" : "Copy"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
