import { useEffect, useRef, useState } from "react";
import type { PeerSummary } from "../../shared/protocol.js";
import type { ClipboardBeamItem } from "../engine/warpClient.js";

interface ClipboardCenterProps {
  peers: PeerSummary[];
  items: ClipboardBeamItem[];
  autoSync: boolean;
  hostClipboardActive: boolean;
  /** When false, incoming clipboard beams are blocked on this device. */
  receiveEnabled: boolean;
  /** Preselect this peer when opened from a device row. */
  initialPeerId?: string | null;
  /** Text shared via the Android Share Sheet arrives prefilled. */
  prefill?: string;
  onToggleAutoSync: (enabled: boolean) => void;
  onToggleReceive: (enabled: boolean) => void;
  onMarkCopied?: (text: string) => void;
  onSend: (peerId: string, text: string) => Promise<void>;
  onSendImage: (peerId: string, dataUrl: string, name?: string) => Promise<void>;
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
  receiveEnabled,
  initialPeerId,
  prefill,
  onToggleAutoSync,
  onToggleReceive,
  onMarkCopied,
  onSend,
  onSendImage,
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
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [imageName, setImageName] = useState<string>("");
  const imageInputRef = useRef<HTMLInputElement>(null);

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

  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      if (!file.type.startsWith('image/')) { reject(new Error('Only images are allowed here.')); return; }
      if (file.size > 5 * 1024 * 1024) { reject(new Error('Image must be under 5 MB.')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Could not read image'));
      reader.readAsDataURL(file);
    });

  const handleImageFile = async (file: File) => {
    try {
      const dataUrl = await fileToDataUrl(file);
      setImageDataUrl(dataUrl);
      setImageName(file.name);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load image');
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!peerId || sending) return;
    // Prefer image if present
    if (imageDataUrl) {
      setSending(true);
      setError(null);
      try {
        await onSendImage(peerId, imageDataUrl, imageName);
        setImageDataUrl(null);
        setImageName('');
        textareaRef.current?.focus();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not beam this image.');
      } finally { setSending(false); }
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;
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

  const handlePasteWithImage = async (e: React.ClipboardEvent) => {
    // If clipboard contains an image, capture it
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type.startsWith('image/')) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault();
          await handleImageFile(file);
          return;
        }
      }
    }
  };

  const handleDropImage = async (e: React.DragEvent) => {
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.type.startsWith('image/')) {
        e.preventDefault();
        await handleImageFile(file);
      }
    }
  };

  const copyItem = (item: ClipboardBeamItem) => {
    onMarkCopied?.(item.text);
    try {
      if (item.contentType === 'image' && item.imageDataUrl) {
        // Try to write image to clipboard as well; fallback to text copy
        if (navigator.clipboard && (window as unknown as { ClipboardItem?: unknown }).ClipboardItem) {
          fetch(item.imageDataUrl).then(r => r.blob()).then(blob => {
            const ClipboardItemCtor = (window as unknown as { ClipboardItem: new (d: Record<string, Blob>) => unknown }).ClipboardItem;
            const ci = new ClipboardItemCtor({ [blob.type]: blob });
            (navigator.clipboard.write as (items: unknown[]) => Promise<void>)([ci]).catch(() => navigator.clipboard?.writeText(item.imageDataUrl!));
          }).catch(() => navigator.clipboard?.writeText(item.text).catch(() => {}));
        } else {
          navigator.clipboard?.writeText(item.text).catch(() => {});
        }
      } else {
        navigator.clipboard?.writeText(item.text).catch(() => {});
      }
    } catch {
      // ignore — user can still select the text manually
    }
    setCopiedBeamId(item.beamId);
    window.setTimeout(() => {
      setCopiedBeamId((current) => (current === item.beamId ? null : current));
    }, 1500);
  };

  const saveImageItem = (item: ClipboardBeamItem) => {
    if (!item.imageDataUrl) return;
    const a = document.createElement('a');
    a.href = item.imageDataUrl;
    a.download = item.imageName || `airbridge-image-${item.beamId.slice(0,6)}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const canSend = (text.trim().length > 0 || Boolean(imageDataUrl)) && Boolean(peerId) && !sending;

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
          AES-256-GCM session as file transfers). Incoming content is copied to this
          device&apos;s clipboard automatically. Images up to 5 MB can be beamed as well.
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
        <label className="setting-toggle clipboard-auto-toggle">
          <span>
            <strong>Receive clipboard beams</strong>
            <small>
              {receiveEnabled ? "Incoming beams are saved and copied to clipboard. Turn off to block receiving while still beaming." : "Receiving is paused — you can still beam to the other device."}
            </small>
          </span>
          <input
            type="checkbox"
            checked={receiveEnabled}
            onChange={(event) => onToggleReceive(event.target.checked)}
          />
        </label>
        {!receiveEnabled && <p className="clipboard-empty" role="status">Receiving is blocked on this device. Outgoing beams still work.</p>}

        <form className="clipboard-compose" onSubmit={handleSubmit} onDragOver={(e) => e.preventDefault()} onDrop={handleDropImage}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={handlePasteWithImage}
            rows={4}
            placeholder="Paste a link, 2FA code, Wi-Fi password, command… or drop/paste an image"
            aria-label="Text to send to the other device"
          />
          <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" className="visually-hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageFile(f); e.target.value=''; }} />
          {imageDataUrl && (
            <div className="clipboard-image-preview">
              <img src={imageDataUrl} alt="preview" />
              <div className="clipboard-image-meta">
                <span>{imageName} • {(imageDataUrl.length * 3 / 4 / 1024).toFixed(0)} KB</span>
                <button type="button" className="text-button" onClick={() => { setImageDataUrl(null); setImageName(''); }}>Remove</button>
              </div>
            </div>
          )}
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
              <button type="button" className="quiet-button" onClick={() => imageInputRef.current?.click()}>Add image</button>
              <button
                type="submit"
                className="beam-button"
                disabled={!canSend}
              >
                {sending ? "Beaming…" : imageDataUrl ? "Beam image" : "Beam text"}
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
                  {item.contentType === 'image' && item.imageDataUrl ? (
                    <div className="clipboard-image-history">
                      <img src={item.imageDataUrl} alt={item.imageName || 'shared image'} />
                      {item.imageName && <small>{item.imageName}</small>}
                    </div>
                  ) : (
                    <pre>{item.text}</pre>
                  )}
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
                    {item.contentType === 'image' && item.imageDataUrl && (
                      <button type="button" className="text-button" onClick={() => saveImageItem(item)}>Save</button>
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
