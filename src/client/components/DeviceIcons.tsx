import type { PlatformType, FormFactor } from '../../shared/protocol.js';

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
    <svg viewBox="0 0 40 40" fill="none" className={className} aria-hidden="true">
      <rect
        x="1"
        y="1"
        width="38"
        height="38"
        rx="10"
        className="fill-slate-900 dark:fill-slate-900/90"
        stroke="rgba(56,189,248,0.35)"
        strokeWidth="1.2"
      />
      <circle
        cx="20"
        cy="20"
        r="13.5"
        stroke="rgba(52,211,153,0.28)"
        strokeWidth="1.2"
        strokeDasharray="2.5 2.5"
      />
      <circle cx="20" cy="20" r="8.8" stroke="rgba(56,189,248,0.5)" strokeWidth="1.2" />
      <path
        d="M11.5 17.8H27.5L24.3 14.6"
        stroke="#34D399"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M28.5 22.2H12.5L15.7 25.4"
        stroke="#38BDF8"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
