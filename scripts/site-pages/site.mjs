/** Shared site constants for the generated airbridge.fyi pages. */
export const SITE = {
  baseUrl: 'https://airbridge.fyi',
  repoUrl: 'https://github.com/DigantaDey/AirBridge',
  releasesUrl: 'https://github.com/DigantaDey/AirBridge/releases/latest',
  installSh:
    'curl -fsSL https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.sh | bash',
  installPs1:
    'powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/DigantaDey/AirBridge/main/install.ps1 -UseBasicParsing | iex"',
  apkUrl:
    'https://github.com/DigantaDey/AirBridge/releases/latest/download/AirBridge-android-debug.apk',
  footerGuides: [
    'android-to-mac-file-transfer',
    'android-to-windows-file-transfer',
    'android-to-linux-file-transfer',
    'android-airdrop-alternative',
    'android-clipboard-sync',
    'android-screen-sharing',
  ],
};
