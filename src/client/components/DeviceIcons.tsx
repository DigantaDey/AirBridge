import type { PlatformType, FormFactor } from '../../shared/protocol.js';
import {
  AIRBRIDGE_MARK_GRADIENT_STOPS,
  AIRBRIDGE_MARK_PATH,
  AIRBRIDGE_MARK_VIEWBOX,
} from './brandMarkPath.js';

interface DeviceIconProps {
  platform: PlatformType;
  formFactor?: FormFactor;
  className?: string;
}

export function DeviceHardwareIcon({ platform, formFactor, className = 'w-6 h-6' }: DeviceIconProps) {
  if (platform === 'android' || formFactor === 'phone') {
    return (
      <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
        <rect
          x="7"
          y="2.5"
          width="14"
          height="23"
          rx="3.2"
          stroke="currentColor"
          strokeWidth="1.75"
        />
        {/* Android punch-hole camera */}
        <circle cx="14" cy="5.3" r="0.9" fill="currentColor" />
        {/* Gesture bar */}
        <path
          d="M11.5 22.8H16.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  if (formFactor === 'tablet' || platform === 'ios') {
    return (
      <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
        <rect
          x="5"
          y="3"
          width="18"
          height="22"
          rx="2.8"
          stroke="currentColor"
          strokeWidth="1.75"
        />
        <circle cx="14" cy="22.3" r="0.9" fill="currentColor" />
      </svg>
    );
  }

  // MacBook / Laptop silhouette (with subtle display notch & unibody base)
  return (
    <svg viewBox="0 0 28 28" fill="none" className={className} aria-hidden="true">
      <path
        d="M5.5 7.2C5.5 6.09543 6.39543 5.2 7.5 5.2H20.5C21.6046 5.2 22.5 6.09543 22.5 7.2V18.5H5.5V7.2Z"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      {/* MacBook camera notch */}
      <path d="M12.2 5.4H15.8V6.5C15.8 6.8 15.5 7 15.2 7H12.8C12.5 7 12.2 6.8 12.2 6.5V5.4Z" fill="currentColor" />
      {/* Aluminum unibody base */}
      <path
        d="M2.5 18.8H25.5L24.3 21.1C23.95 21.75 23.3 22.1 22.55 22.1H5.45C4.7 22.1 4.05 21.75 3.7 21.1L2.5 18.8Z"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AirBridgeLogo({ className = 'w-8 h-8' }: { className?: string }) {
  return (
    <svg viewBox={AIRBRIDGE_MARK_VIEWBOX} className={className} aria-hidden="true">
      <defs>
        <linearGradient id="airbridge-mark-gradient" x1="0" y1="0" x2="1" y2="1">
          {AIRBRIDGE_MARK_GRADIENT_STOPS.map((stop) => (
            <stop key={stop.offset} offset={stop.offset} stopColor={stop.color} />
          ))}
        </linearGradient>
      </defs>
      <path d={AIRBRIDGE_MARK_PATH} fill="url(#airbridge-mark-gradient)" fillRule="evenodd" />
    </svg>
  );
}
