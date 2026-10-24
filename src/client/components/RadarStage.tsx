import { useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Clipboard,
  File,
  Laptop,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  Radio,
  ShieldCheck,
  Smartphone,
  Upload,
  Wifi,
  X,
} from "lucide-react";
import {
  type DeviceProfile,
  type LocalDaemonStatus,
  type PeerSummary,
  formatBytes,
} from "../../shared/protocol.js";
import {
  type PeerSecurityInfo,
  type SendableFileInput,
  wrapBrowserFile,
} from "../engine/warpClient.js";
import { extractDroppedFiles } from "../engine/fileDropUtils.js";

interface RadarStageProps {
  connectionState: "connecting" | "connected" | "reconnecting" | "disconnected";
  visibility: import("../../shared/protocol.js").VisibilityMode;
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
  onRenameDevice: (name: string) => void;
  onOpenSimulator: () => void;
}

export function RadarStage(p: RadarStageProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState("");
  const target =
    p.peers.find((peer) => peer.peerId === selected) ??
    (p.peers.length === 1 ? p.peers[0] : undefined);
  const stage = (files: SendableFileInput[]) => {
    p.onStageFiles(files);
    setError("");
  };
  return (
    <section className="send-workspace">
      <div className="workspace-label">
        <span>
          <Radio size={15} /> YOUR WORKSPACE
        </span>
        <span className="live-label">
          <i />{" "}
          {p.connectionState === "connected"
            ? "Live discovery"
            : "Not connected"}
        </span>
      </div>
      <div
        className="drop-surface"
        data-dragging={dragging}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setDragging(false);
        }}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          try {
            stage(await extractDroppedFiles(e.dataTransfer));
          } catch {
            setError(
              "Could not read those files. Try the file picker instead.",
            );
          }
        }}
      >
        <div className="device-scene" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="scene-laptop">
            <Laptop size={76} strokeWidth={1.2} />
            <span className="scene-dot" />
          </div>
          <div className="scene-link">
            <ArrowUpRight size={20} />
          </div>
          <div className="scene-phone">
            <Smartphone size={49} strokeWidth={1.3} />
            <span className="phone-green" />
          </div>
          <span className="scene-spark spark-one">+</span>
          <span className="scene-spark spark-two">+</span>
        </div>
        <div className="private-badge">
          <ShieldCheck size={13} /> Your files. Just between your devices.
        </div>
        <h2>
          Goodbye cables.
          <br />
          Hello, <em>AirBridge.</em>
        </h2>
        <p>
          That photo on your phone. That file on your Mac.
          <br />
          Bring them together, without the workarounds.
        </p>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files)
              stage(Array.from(e.target.files).map((f) => wrapBrowserFile(f)));
            e.target.value = "";
          }}
        />
        <button
          className="primary-button"
          onClick={() => input.current?.click()}
        >
          <Plus size={18} /> Choose files <span>↗</span>
        </button>
        <span className="drop-hint">or drag and drop files anywhere here</span>
        <div className="drop-features">
          <span>
            <ShieldCheck size={14} /> End-to-end encrypted
          </span>
          <b>·</b>
          <span>
            <Wifi size={14} /> No cloud storage
          </span>
          <b>·</b>
          <span>Original quality</span>
        </div>
      </div>
      {error && (
        <p role="alert" className="workspace-error">
          {error}
        </p>
      )}
      {p.stagedFiles.length > 0 && (
        <div className="staged-card">
          <div>
            <File size={19} />
            <span>
              <strong>
                {p.stagedFiles.length} file{p.stagedFiles.length > 1 ? "s" : ""}{" "}
                ready to send
              </strong>
              <small>
                {formatBytes(p.stagedFiles.reduce((n, f) => n + f.size, 0))} ·{" "}
                {target
                  ? `To ${target.device.name}`
                  : "Select a connected device below"}
              </small>
            </span>
          </div>
          <button
            className="primary-button"
            disabled={!target}
            onClick={() => {
              if (target) {
                p.onSendFilesToPeer(target.peerId, p.stagedFiles);
                p.onClearStagedFiles();
              }
            }}
          >
            <Upload size={15} /> Send
          </button>
          <button
            aria-label="Clear selected files"
            onClick={p.onClearStagedFiles}
          >
            <X size={17} />
          </button>
        </div>
      )}
      <div className="nearby-heading">
        <h3>
          Nearby devices <span>{p.peers.length}</span>
        </h3>
        <span>
          <Loader2 size={13} className="discovery-spin" />{" "}
          {p.connectionState !== "connected"
            ? "Waiting for connection"
            : p.visibility === "hidden"
              ? "Discovery is off"
              : "Looking for devices"}
        </span>
      </div>
      {p.peers.length === 0 ? (
        <div className="empty-devices">
          <div className="empty-device-icon">
            <Smartphone size={24} />
          </div>
          <div>
            <strong>A little closer. A lot more connected.</strong>
            <p>
              Scan the pairing QR, or enter the same code on your other device.
            </p>
            <button className="text-link" onClick={p.onOpenSimulator}>
              Try it with a virtual device <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="signal-bars">
            <i />
            <i />
            <i />
          </div>
        </div>
      ) : (
        <div className="peer-grid">
          {p.peers.map((peer) => (
            <div
              className={`peer-card ${target?.peerId === peer.peerId ? "selected" : ""}`}
              key={peer.peerId}
            >
              <button
                className="peer-select"
                onClick={() => setSelected(peer.peerId)}
              >
                <div className="peer-icon">
                  {peer.device.formFactor === "phone" ? (
                    <Smartphone />
                  ) : (
                    <Laptop />
                  )}
                </div>
                <span>
                  <strong>{peer.device.name}</strong>
                  <small>
                    <i />{" "}
                    {peer.discoveryScope === "paired"
                      ? "Paired device"
                      : "On your network"}
                  </small>
                </span>
                {target?.peerId === peer.peerId && <Check size={17} />}
              </button>
              <div className="peer-actions">
                <button onClick={() => p.onOpenClipboardForPeer(peer)}>
                  <Clipboard size={13} /> Send text
                </button>
                <button
                  onClick={() =>
                    p.onToggleTrustPeer(
                      peer.device.publicKey,
                      !p.trustedPeerKeys.includes(peer.device.publicKey),
                    )
                  }
                >
                  <ShieldCheck size={13} />
                  {p.trustedPeerKeys.includes(peer.device.publicKey)
                    ? "Trusted"
                    : "Trust device"}
                </button>
              </div>
              {p.peerSecurity[peer.peerId]?.sasCode && (
                <small className="security-code">
                  Verify on both screens: {p.peerSecurity[peer.peerId].sasCode}
                </small>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="this-device">
        <div className="this-device-icon">
          <Monitor size={20} />
        </div>
        <div>
          {editing ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim()) p.onRenameDevice(name.trim().slice(0, 48));
                setEditing(false);
              }}
            >
              <input
                aria-label="Device name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={48}
              />
              <button aria-label="Save device name">
                <Check size={15} />
              </button>
            </form>
          ) : (
            <strong>
              {p.myDevice?.name ?? "Connecting your device…"}{" "}
              <button
                aria-label="Rename your device"
                onClick={() => {
                  setName(p.myDevice?.name ?? "");
                  setEditing(true);
                }}
              >
                <Pencil size={12} />
              </button>
            </strong>
          )}
          <small>
            This device <span>·</span> {p.myDevice?.platform ?? "Discovering"}
          </small>
        </div>
        <span className="device-online">
          <i />{" "}
          {p.connectionState !== "connected"
            ? "Not connected"
            : p.visibility === "hidden"
              ? "You’re hidden"
              : p.visibility === "paired-only"
                ? "Paired devices only"
                : "You’re discoverable"}
        </span>
      </div>
    </section>
  );
}
