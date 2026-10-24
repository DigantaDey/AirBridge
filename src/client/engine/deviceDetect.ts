import type { DeviceProfile, FormFactor, PlatformType } from '../../shared/protocol.js';

const CALLSIGNS = [
  'Atlas',
  'Nova',
  'Vega',
  'Orion',
  'Pulse',
  'Zenith',
  'Solstice',
  'Quartz',
  'Cobalt',
  'Kestrel',
  'Apex',
  'Drift',
];

function pickCallsign(): string {
  const bytes = new Uint8Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return CALLSIGNS[bytes[0] % CALLSIGNS.length];
}

export function detectHardwareProfile(uaInput?: string): {
  platform: PlatformType;
  model: string;
  formFactor: FormFactor;
  defaultBaseName: string;
} {
  const ua = uaInput ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');

  if (/Android/i.test(ua)) {
    const isTablet = !/Mobile/i.test(ua);
    let model = 'Android';
    if (/Pixel\s*(\d+\s*(?:Pro|a|Fold)?)/i.test(ua)) {
      const m = ua.match(/Pixel\s*(\d+\s*(?:Pro|a|Fold)?)/i);
      model = m ? `Pixel ${m[1].trim()}` : 'Pixel';
    } else if (/SM-[A-Z0-9]+|Samsung|Galaxy/i.test(ua)) {
      model = 'Galaxy';
    } else if (/Nothing|A063|A065|A142/i.test(ua)) {
      model = 'Nothing Phone';
    } else if (/OnePlus|CPH\d+/i.test(ua)) {
      model = 'OnePlus';
    }
    return {
      platform: 'android',
      model,
      formFactor: isTablet ? 'tablet' : 'phone',
      defaultBaseName: model,
    };
  }

  if (/iPad|iPhone|iPod/i.test(ua)) {
    const isPad = /iPad/i.test(ua);
    return {
      platform: 'ios',
      model: isPad ? 'iPad' : 'iPhone',
      formFactor: isPad ? 'tablet' : 'phone',
      defaultBaseName: isPad ? 'iPad' : 'iPhone',
    };
  }

  if (/Macintosh|Mac OS X/i.test(ua)) {
    return {
      platform: 'macos',
      model: 'MacBook',
      formFactor: 'laptop',
      defaultBaseName: 'MacBook Pro',
    };
  }

  if (/Windows/i.test(ua)) {
    return {
      platform: 'windows',
      model: 'Windows PC',
      formFactor: 'laptop',
      defaultBaseName: 'Studio PC',
    };
  }

  if (/Linux/i.test(ua)) {
    return {
      platform: 'linux',
      model: 'Linux Workstation',
      formFactor: 'laptop',
      defaultBaseName: 'Workstation',
    };
  }

  return {
    platform: 'unknown',
    model: 'Device',
    formFactor: 'laptop',
    defaultBaseName: 'Device',
  };
}

export function loadOrCreateDeviceProfile(
  publicKeyB64: string,
  storageKeyPrefix = 'airbridge'
): DeviceProfile {
  const hw = detectHardwareProfile();
  let savedName = '';
  try {
    savedName = localStorage.getItem(`${storageKeyPrefix}:deviceName`) || '';
  } catch {
    // ignore storage errors
  }

  if (!savedName) {
    savedName = `${hw.defaultBaseName} · ${pickCallsign()}`;
    try {
      localStorage.setItem(`${storageKeyPrefix}:deviceName`, savedName);
    } catch {
      // ignore
    }
  }

  return {
    name: savedName,
    platform: hw.platform,
    model: hw.model,
    formFactor: hw.formFactor,
    publicKey: publicKeyB64,
  };
}

export function saveDeviceName(name: string, storageKeyPrefix = 'airbridge'): void {
  try {
    localStorage.setItem(`${storageKeyPrefix}:deviceName`, name.trim());
  } catch {
    // ignore
  }
}
