import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { formatSpeed } from "../../shared/protocol.js";
import type { TransferSessionView } from "../engine/warpClient.js";

interface TransferSpeedProps {
  /** The active transfer whose local rate should be shown. */
  transfer: TransferSessionView;
  /** Append the estimated time remaining when the engine has a useful estimate. */
  showEta?: boolean;
  /** Draw a direction arrow next to the label. */
  showIcon?: boolean;
  /** Extra classes for the host layout (sizes, colours, spacing). */
  className?: string;
}

/**
 * One consistent live rate for every transfer surface.
 *
 * Both devices render this same component: an outgoing session is the local
 * Upload rate, an incoming session is the local Download rate. The value is a
 * polite live region so assistive technology hears rate changes without the
 * whole transfer list being announced repeatedly.
 */
export function TransferSpeed({
  transfer,
  showEta = true,
  showIcon = true,
  className = "",
}: TransferSpeedProps) {
  const isDownload = transfer.direction === "incoming";
  const label = isDownload ? "Download" : "Upload";
  const speedText = `${label} ${formatSpeed(transfer.speedBytesPerSec)}`;
  const eta =
    showEta &&
    typeof transfer.etaSeconds === "number" &&
    Number.isFinite(transfer.etaSeconds) &&
    transfer.etaSeconds > 0
      ? ` · ${Math.ceil(transfer.etaSeconds)}s left`
      : "";
  const text = `${speedText}${eta}`;
  const DirectionIcon = isDownload ? ArrowDownLeft : ArrowUpRight;

  return (
    <span
      className={`transfer-speed ${className}`.trim()}
      data-testid="transfer-speed"
      data-direction={transfer.direction}
      data-rate-bytes-per-sec={Math.max(0, transfer.speedBytesPerSec)}
      aria-label={text}
      aria-live="polite"
    >
      {showIcon && (
        <DirectionIcon
          className="transfer-speed-icon"
          aria-hidden="true"
          focusable="false"
        />
      )}
      <span className="transfer-speed-text">{text}</span>
    </span>
  );
}

/** Plain-text version for native bridges and other non-React consumers. */
export function formatTransferSpeedLabel(transfer: TransferSessionView): string {
  const label = transfer.direction === "incoming" ? "Download" : "Upload";
  return `${label} ${formatSpeed(transfer.speedBytesPerSec)}`;
}
