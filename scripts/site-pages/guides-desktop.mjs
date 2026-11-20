/**
 * Platform guides: Android → macOS, Windows and Linux, plus the AirDrop-alternative
 * explainer. Facts come from README.md, docs/DISTRIBUTION.md, install.sh and
 * install.ps1 so the pages cannot drift away from what the product does.
 */
import { SITE } from './site.mjs';

const downloadAside = `
        <p>The official builds, the Android APK and <code>SHA256SUMS.txt</code> are published on the <a href="${SITE.releasesUrl}">GitHub releases page</a>. Every release also carries keyless Sigstore build-provenance attestations you can check with <code>gh attestation verify</code>.</p>`;

export const MAC = {
  slug: 'android-to-mac-file-transfer',
  group: 'guide',
  shortTitle: 'Android to Mac file transfer',
  cardBlurb: 'Wi-Fi file transfer from Android to macOS with resume, SHA-256 checks and no cloud upload.',
  title: 'Android to Mac File Transfer Without a Cable or Cloud — AirBridge',
  description:
    'Transfer files from Android to a Mac over your own Wi-Fi: end-to-end encrypted, resumable multi-gigabyte sends, SHA-256 verified before saving, no account or cloud upload.',
  kicker: 'ANDROID → MACOS',
  h1: 'Android to Mac file transfer without a cable, an account, or an upload',
  lede:
    'AirDrop stops at Apple’s own devices, so Android phones are left out. AirBridge is an open-source bridge for the other direction: install the macOS companion, pair your phone with a QR code, and files travel directly between the two devices on your network, end-to-end encrypted.',
  image: 'screenshots/desktop-file-transfer.jpg',
  imageWidth: 1600,
  imageHeight: 967,
  imageAlt:
    'AirBridge for macOS sending a 1.68 GB video file to a paired Android phone, showing upload speed, remaining time and SHA-256 verification in the footer',
  imageCaption:
    'AirBridge v2.5.0 on macOS mid-transfer: a 1.68 GB video to a paired Android phone, with live speed and remaining time.',
  sections: [
    {
      id: 'problem',
      h2: 'Why Android to Mac file transfer is still awkward',
      html: `        <ul>
          <li><strong>AirDrop and Universal Clipboard are Apple-only.</strong> They rely on proprietary protocols and Apple IDs, so an Android phone cannot join even when it is sitting next to the Mac.</li>
          <li><strong>USB copy is a cable, an app and a protocol.</strong> Android File Transfer and MTP mounts work until they don’t: large videos stall, the phone unmounts, and macOS updates break the helper app.</li>
          <li><strong>Cloud drives mean two uploads.</strong> The file leaves your devices, costs quota, needs an account on both sides, and is usually no faster than your Wi-Fi link.</li>
          <li><strong>Chat apps compress media</strong> and cap attachment sizes, which defeats the point when you are moving a 2 GB video.</li>
          <li><strong>Bluetooth is far too slow</strong> for anything beyond a contact card or a small photo.</li>
        </ul>
        <p>AirBridge solves the specific case of “my file is on my phone and I need it on my Mac, now, without sending it through somebody’s data centre.”</p>`,
    },
    {
      id: 'how-it-works',
      h2: 'How AirBridge moves a file from Android to macOS',
      html: `        <p>AirBridge runs a native menu-bar app on the Mac and a native Android app on the phone. The desktop service owns the encrypted session; the window you see on the Mac is a view over it.</p>
        <ol>
          <li><strong>Pair once.</strong> Open AirBridge on the Mac, scan the QR code from the Android app (or type the six-character pairing code). The code is never transmitted — not even as a hash — because pairing uses SPAKE2 (RFC 9382).</li>
          <li><strong>Choose the files.</strong> Either use <em>Share → AirBridge</em> from any Android app, or pick files inside AirBridge. Up to 100 files go into a single transfer session.</li>
          <li><strong>Accept on the Mac.</strong> The receiving side sees the manifest and accepts (a trusted device can auto-accept). Nothing is decrypted or written before you accept.</li>
          <li><strong>Stream straight to disk.</strong> A binary windowed pipeline with TCP backpressure writes into a private <code>.part</code> journal, so a multi-gigabyte video never has to fit in RAM. Chunks default to 1 MiB (16 KiB–1 MiB supported).</li>
          <li><strong>Verify, then save.</strong> The incremental and final SHA-256 digests must match before the file is renamed into <code>~/Downloads/AirBridge</code> (configurable in Settings or with <code>AIRBRIDGE_DOWNLOAD_DIR</code>). <em>Reveal</em> opens Finder at the file.</li>
        </ol>
        <p>If the Wi-Fi link wobbles, the sender resumes inside the same running session: consent stays tied to the same encrypted peer key and the same manifest. A force-stopped process or a changed identity starts a fresh, verified send instead of pretending the old one is valid.</p>`,
    },
    {
      id: 'encryption',
      h2: 'What is encrypted, and what you can verify yourself',
      html: `        <p>Pairing proves knowledge of the code without revealing it (SPAKE2). Session keys come from ephemeral ECDH P-256 plus HKDF; every file chunk, clipboard item, call audio frame and screen frame is sealed with AES-256-GCM. On first contact both devices show a six-digit SAS fingerprint you can compare out loud — that is the step that defeats a man-in-the-middle.</p>
        <p>The Android app also pins your Mac’s local TLS certificate authority and refuses to silently fall back to plaintext. Host-only actions — writing the Mac clipboard, saving into the receive folder, opening Finder — are loopback-only, so a paired phone cannot ask the Mac to run arbitrary commands.</p>
        <p>The project publishes its own threat model and audit notes in <a href="${SITE.repoUrl}/blob/main/SECURITY.md">SECURITY.md</a>. Those notes are the maintainer’s review, not a third-party security audit, and the site does not claim otherwise.</p>`,
    },
    {
      id: 'install',
      h2: 'Step 1 — install the macOS companion',
      html: `        <p>One command installs the prebuilt app without sudo, Xcode or an Apple Developer account:</p>
        <pre><code>${SITE.installSh}</code></pre>
        <p>The script puts <code>AirBridge.app</code> in <code>~/Applications</code>, links the <code>AirBridge</code> command into <code>~/.local/bin</code>, and can register a login item with <code>--autostart</code>. Prefer a manual download? Use <code>AirBridge-macOS-arm64.zip</code> or <code>AirBridge-macOS-x64.zip</code> from the release, or the single-file <code>AirBridge-darwin-arm64</code> / <code>AirBridge-darwin-x64</code> binaries.</p>
        <p><strong>Honest caveat:</strong> the Mac build is ad-hoc signed, not notarised, because notarisation requires a paid Apple Developer account. Installed through <code>curl</code> there is no quarantine flag and Gatekeeper stays quiet; if you download a zip in a browser instead, right-click → <em>Open</em> the first time. macOS may also ask you to allow AirBridge on the local network — that prompt is the transfer service, and declining it stops discovery.</p>`,
    },
    {
      id: 'install-android',
      h2: 'Step 2 — install the Android app and pair',
      html: `        <p>The Android side is a native Jetpack Compose app for Android 8.0 (API 26) and newer. The release page carries <a href="${SITE.apkUrl}">AirBridge-android-debug.apk</a>, an installable testing/sideload build; the Play-ready release flow is documented in <a href="${SITE.repoUrl}/blob/main/docs/PLAY_STORE_RELEASE.md">docs/PLAY_STORE_RELEASE.md</a>.</p>
        <p>After installing, scan the QR code on the Mac and compare the six-digit verification code. Every continuity permission — contacts, phone calls, call microphone, screen capture — is off until you enable that specific feature in <em>Settings → Phone on your computer</em>.</p>`,
    },
    {
      id: 'network',
      h2: 'If the phone and Mac are not on the same Wi-Fi',
      html: `        <ul>
          <li><strong>Phone hotspot handoff.</strong> Tap <em>Use this phone’s hotspot</em> in the Android app and approve the join on the Mac. The sealed Wi-Fi credentials travel over the encrypted session — or over Bluetooth LE on the macOS app when there is no connection at all yet.</li>
          <li><strong>Self-hostable relay.</strong> When a direct path is impossible (different networks, client isolation, CGNAT), the phone can route through a relay you run with <code>airbridge relay --listen 0.0.0.0:47391</code>. TLS stays end to end and pinned, so the relay only ever sees ciphertext, and the session switches back to a direct path when one appears.</li>
        </ul>`,
    },
    {
      id: 'limits',
      h2: 'Limits worth knowing before you install',
      html: `        <ul>
          <li><strong>No iOS app.</strong> AirBridge connects Android to macOS, Windows and Linux. iPhone-to-Android is not supported.</li>
          <li><strong>Both apps are required</strong> for the full experience. A browser tab can receive files, but a browser-only receiver is memory-capped (128 MiB) — use the native app or the daemon for large files.</li>
          <li><strong>Resume is per running session.</strong> Android force-stop, reboot or a revoked file permission ends it; the next attempt is a normal, freshly verified transfer.</li>
          <li><strong>No remote control.</strong> Screen sharing is viewing only; AirBridge does not inject taps or keystrokes into your phone.</li>
          <li><strong>Aggressive battery management</strong> on some Android OEM builds can stop long screen-off transfers. AirBridge documents the setting to change instead of promising it cannot happen.</li>
        </ul>`,
    },
  ],
  faqs: [
    {
      q: 'Do I need Google Drive, iCloud or Dropbox to send files from Android to Mac?',
      a: 'No. Files move directly between the phone and the Mac over your local network (or through a relay you can self-host if no direct path exists). There is no AirBridge account, no cloud copy and no upload step.',
    },
    {
      q: 'How large can a transfer be?',
      a: 'Up to 100 files per session. The protocol caps a manifest at 262,144 chunks, which is roughly 256 GiB at the default 1 MiB chunk size — an allocation guard rather than a bandwidth limit. The native Mac app streams straight to disk, so a file never has to fit in memory; a browser-only receiver is capped at 128 MiB.',
    },
    {
      q: 'Does AirBridge work without internet access?',
      a: 'Yes. A shared Wi-Fi network, or the phone’s own hotspot joined by the Mac, is enough. The optional relay exists for phones and computers that cannot reach each other directly; it is only needed when no direct path exists, and it only ever carries ciphertext.',
    },
    {
      q: 'Where do received files go on the Mac?',
      a: 'By default to ~/Downloads/AirBridge. You can change the receive folder in AirBridge Settings or set AIRBRIDGE_DOWNLOAD_DIR. Files are only published there after the SHA-256 digest matches.',
    },
    {
      q: 'Is AirBridge available on the Mac App Store?',
      a: 'No. It is distributed as an ad-hoc signed app through install.sh and the release zips, which keeps it free of Apple Developer fees. The trade-off is that a browser-downloaded copy needs one right-click → Open on first launch.',
    },
  ],
  related: ['android-airdrop-alternative', 'android-to-windows-file-transfer', 'android-clipboard-sync', 'private-file-transfer'],
};

export const WINDOWS = {
  slug: 'android-to-windows-file-transfer',
  group: 'guide',
  shortTitle: 'Android to Windows file transfer',
  cardBlurb: 'Portable Windows app, no admin rights, encrypted Wi-Fi transfers from Android.',
  title: 'Android to Windows File Transfer Over Wi-Fi — AirBridge',
  description:
    'Send files from Android to Windows over Wi-Fi with a portable app: no USB drivers, no admin rights, end-to-end encryption, resumable transfers and SHA-256 checks.',
  kicker: 'ANDROID → WINDOWS',
  h1: 'Android to Windows file transfer without USB drivers or an account',
  lede:
    'Windows and Android talk to each other only when an app is installed on both sides. AirBridge is that app: a portable Windows executable, a native Android app, and an encrypted direct connection over your own network instead of an upload queue.',
  image: 'screenshots/phone-transfers.jpg',
  imageWidth: 720,
  imageHeight: 1600,
  imageAlt:
    'AirBridge on Android downloading a 1.68 GB file from a paired computer at 27.5 MB/s, with a progress bar and SHA-256 fingerprint',
  imageCaption:
    'The Android side of the same transfer: 1.68 GB arriving at 27.5 MB/s from a paired computer, with the verified SHA-256 fingerprint shown under the progress bar.',
  sections: [
    {
      id: 'problem',
      h2: 'Why Android to Windows file transfer is still fiddly',
      html: `        <ul>
          <li><strong>Nearby sharing is not always available.</strong> Google’s Quick Share works on supported Windows PCs, but availability depends on device, region and how the feature is installed — and it is not open source.</li>
          <li><strong>USB MTP needs drivers and patience.</strong> The phone appears as a camera-like device, large copies stall, and some OEM cable/driver combinations simply fail.</li>
          <li><strong>Phone-link style apps have narrow scope.</strong> They are strongest at notifications, calls and recent photos rather than transferring an arbitrary 3 GB file into a folder you choose.</li>
          <li><strong>Cloud drives need an account on both sides</strong> and upload the file before it can be downloaded, which is slower and leaves a copy outside your devices.</li>
        </ul>`,
    },
    {
      id: 'how-it-works',
      h2: 'What AirBridge does on Windows',
      html: `        <p>The Windows build is a single portable executable. It starts the AirBridge transfer service, opens the app UI in your browser at <code>http://localhost:3000</code>, and keeps an encrypted background session open for clipboard sync and incoming offers.</p>
        <ul>
          <li><strong>Direct device-to-device transfer</strong> over your LAN using WebSockets, with WebRTC data channels when ICE succeeds.</li>
          <li><strong>Resumable, verified file writes</strong> into a private <code>.part</code> journal, published to <code>Downloads\\AirBridge</code> only after the SHA-256 digest matches.</li>
          <li><strong>Clipboard sync</strong> of text in both directions. Windows clipboard reads use the system’s own PowerShell <code>Get-Clipboard</code>/<code>Set-Clipboard</code> worker, so no extra utility has to be installed.</li>
          <li><strong>Phone on your computer:</strong> view the Android screen, browse contacts, see who is calling and place calls from the desktop.</li>
          <li><strong>CLI and daemon</strong> — <code>npx airbridge daemon --dir D:\\Inbox</code> for a headless receiver.</li>
        </ul>`,
    },
    {
      id: 'install',
      h2: 'Install on Windows (no admin required)',
      html: `        <p>Run this in PowerShell:</p>
        <pre><code>${SITE.installPs1}</code></pre>
        <p>The installer downloads <code>AirBridge-windows-x64.exe</code> (or <code>AirBridge-windows-arm64.exe</code> on ARM64 machines) into <code>%LOCALAPPDATA%\\AirBridge</code>, verifies it against the release’s <code>SHA256SUMS.txt</code>, adds that folder to your <em>user</em> PATH, and offers <code>-Autostart</code> through a per-user Run key. Nothing is installed system-wide and no administrator prompt is needed.</p>
        <p><strong>Honest caveat:</strong> the Windows binary is not Authenticode-signed — a code-signing certificate is a paid subscription this project does not use. The installer downloads with the built-in <code>curl.exe</code>, which avoids the Mark-of-the-Web, so SmartScreen does not open on launch. If you grab the EXE in a browser instead, expect a “Windows protected your PC” sheet; compare the SHA-256 with the release notes before allowing it.</p>`,
    },
    {
      id: 'pairing',
      h2: 'Pair the phone, then transfer',
      html: `        <p>Install the Android app, open AirBridge on the PC and scan the QR code (or enter the six-character code). Pairing uses SPAKE2 so the code is never sent over the network, and both screens show a six-digit verification code you can compare. From then on the phone sees the PC as a trusted, verified peer.</p>
        <p>The Windows Firewall may ask whether AirBridge can accept connections on private networks. That prompt matters: the transfer service listens on port 3000 by default (<code>PORT</code> changes it), and blocking it leaves discovery working while transfers fail.</p>`,
    },
    {
      id: 'encryption',
      h2: 'Security model in one paragraph',
      html: `        <p>Ephemeral ECDH P-256 key agreement plus HKDF-derived session keys, AES-256-GCM for every file chunk, clipboard item, call frame and screen frame, and a six-digit SAS to confirm the keys. Host-only actions — writing the clipboard, saving into the receive folder, opening Explorer — are loopback-only. Details, including what an attacker on the same network can still observe, are in <a href="private-file-transfer.html">the privacy guide</a> and <a href="${SITE.repoUrl}/blob/main/SECURITY.md">SECURITY.md</a>.</p>`,
    },
    {
      id: 'limits',
      h2: 'Limits worth knowing',
      html: `        <ul>
          <li><strong>No Store/MSIX package.</strong> AirBridge ships as a portable EXE, so there is no automatic Microsoft Store update path; the desktop build updates itself from signed release artefacts instead.</li>
          <li><strong>Unsigned binaries</strong> mean SmartScreen friction for browser downloads, as described above.</li>
          <li><strong>Clipboard images are macOS-only.</strong> On Windows the desktop clipboard bridge is text, powered by the built-in PowerShell clipboard cmdlets.</li>
          <li><strong>View-only screen sharing.</strong> You can watch the phone screen; you cannot drive the phone from the PC.</li>
          <li><strong>No iPhone or iPad support</strong> anywhere in the product.</li>
        </ul>`,
    },
  ],
  faqs: [
    {
      q: 'Do I need Google Quick Share or Nearby Share on Windows?',
      a: 'No. AirBridge has its own pairing and transport: a QR code or six-character code, then a direct encrypted link over your network. Quick Share is unrelated and can stay unused.',
    },
    {
      q: 'Does the Windows install need administrator rights?',
      a: 'No. The installer writes to %LOCALAPPDATA%\\AirBridge and edits only your user PATH, plus an optional per-user Run key for autostart.',
    },
    {
      q: 'Windows says the app is unsigned. Is that expected?',
      a: 'Yes. Release binaries are not Authenticode-signed. Verify the file against SHA256SUMS.txt on the release page (the installer does this automatically) and prefer the curl-based install command, which does not set Mark-of-the-Web.',
    },
    {
      q: 'Does it work on Windows on ARM?',
      a: 'Yes — AirBridge-windows-arm64.exe is built and published with every release alongside the x64 build.',
    },
    {
      q: 'Which port does AirBridge use?',
      a: 'Port 3000 by default for the HTTP/HTTPS signalling service. Set the PORT environment variable to change it; the local UI stays on http://localhost:3000 unless you change that too.',
    },
  ],
  related: ['android-to-mac-file-transfer', 'android-to-linux-file-transfer', 'android-airdrop-alternative', 'private-file-transfer'],
};

export const LINUX = {
  slug: 'android-to-linux-file-transfer',
  group: 'guide',
  shortTitle: 'Android to Linux file transfer',
  cardBlurb: 'No root, XDG launcher entry, static glibc/musl builds for x64 and arm64.',
  title: 'Android to Linux File Transfer (No Root, No Cloud) — AirBridge',
  description:
    'Move files between Android and Linux over your network: a per-user install with no root, static glibc and musl builds, XDG launcher integration and end-to-end encryption.',
  kicker: 'ANDROID → LINUX',
  h1: 'Android to Linux file transfer that respects your desktop and your permissions',
  lede:
    'Linux already has good device-connectivity projects, but Android-to-Linux file transfer often ends up as an MTP mount, an adb push, or a cloud upload. AirBridge installs per user, speaks the same encrypted protocol as its macOS and Windows builds, and stays out of root’s way.',
  image: 'screenshots/desktop-clipboard.png',
  imageWidth: 1600,
  imageHeight: 905,
  imageAlt:
    'AirBridge desktop clipboard panel on Linux and macOS showing auto-beam settings, a text box for sending a link or 2FA code, and a list of recent clipboard beams',
  imageCaption:
    'The same desktop companion on every platform, here showing the clipboard panel: text, links and 2FA codes beam between the paired phone and the computer.',
  sections: [
    {
      id: 'problem',
      h2: 'The usual ways to get a file from Android to Linux',
      html: `        <ul>
          <li><strong>MTP mounts (gvfs / jmtpfs)</strong> work until a folder has thousands of files or a video is large; indexes time out and the phone re-enumerates.</li>
          <li><strong>adb push</strong> is fast for developers and hostile for everyone else — platform-tools, USB debugging, authorisation prompts, cable.</li>
          <li><strong>scp/rsync</strong> needs an SSH server on the phone, which most Android builds do not ship.</li>
          <li><strong>Cloud drives</strong> route your file through a third party and need an account.</li>
          <li><strong>KDE Connect</strong> is excellent inside KDE Plasma, but its macOS client is unofficial and its feature set is desktop-environment specific.</li>
        </ul>`,
    },
    {
      id: 'how-it-works',
      h2: 'How AirBridge installs and runs on Linux',
      html: `        <p>The same <code>install.sh</code> used for macOS detects Linux, installs the matching static binary into <code>~/.local/bin</code>, and writes an XDG launcher entry — <code>~/.local/share/applications/airbridge.desktop</code> — so AirBridge appears in GNOME, KDE and other application menus with <em>Contacts</em>, <em>Calls</em> and <em>Screen Sharing</em> actions. Nothing requires root, and there is no system-wide package to remove later.</p>
        <ul>
          <li><strong>Builds for both worlds:</strong> glibc and fully static musl binaries for x64 and arm64, so a headless server or an older distro works too.</li>
          <li><strong>Optional autostart:</strong> <code>--autostart</code> registers a systemd <em>user</em> service when available (<code>systemctl --user status airbridge</code>), otherwise a plain <code>~/.config/autostart</code> entry.</li>
          <li><strong>CLI-first when you want it:</strong> <code>airbridge daemon --dir ~/Inbox --reveal</code> for a headless receiver, or <code>AirBridge --open calls</code> to jump straight to a panel in a running instance.</li>
          <li><strong>Relay on an always-on box:</strong> <code>airbridge relay --listen 0.0.0.0:47391</code>, then point a computer at it with <code>airbridge --relay relay.example.com:47391</code>.</li>
        </ul>`,
    },
    {
      id: 'clipboard',
      h2: 'Clipboard sync on Wayland and X11',
      html: `        <p>Desktop clipboard bridging uses the tools your session already provides: <code>wl-paste</code>/<code>wl-copy</code> on Wayland, or <code>xclip</code>/<code>xsel</code> on X11. If none of them is installed, AirBridge reports the clipboard bridge as unsupported instead of failing silently — install <code>wl-clipboard</code> (Wayland) or <code>xclip</code> and the text bridge starts working.</p>
        <p>Photo clipboard capture is a macOS-only capability because it reads native pasteboard image types. On Linux the clipboard bridge carries text: links, commands, 2FA codes, snippets.</p>`,
    },
    {
      id: 'install',
      h2: 'Install in one command',
      html: `        <pre><code>${SITE.installSh}</code></pre>
        <p>Then open AirBridge from your application menu (or run <code>AirBridge</code>), and pair the Android app by scanning the QR code. Prefer packages? There is no deb, rpm, AppImage or Flatpak yet — the static binaries in <a href="${SITE.releasesUrl}">the release</a> are the supported path today, and building from source is documented in the <a href="${SITE.repoUrl}#readme">README</a>.</p>
        ${downloadAside}`,
    },
    {
      id: 'limits',
      h2: 'Limits worth knowing',
      html: `        <ul>
          <li><strong>No distro packaging yet.</strong> Installation is a per-user script plus static binaries, not a distro package with repository updates.</li>
          <li><strong>Desktop integration is XDG-based.</strong> Menu actions and the launcher entry work on freedesktop-compliant desktops; exotic setups may need to launch the binary directly.</li>
          <li><strong>Text-only desktop clipboard</strong> outside macOS, as described above.</li>
          <li><strong>Screen sharing is viewing only</strong>, and computer-to-computer sharing uses the browser’s own screen picker.</li>
          <li><strong>No iOS client.</strong> Android, macOS, Windows and Linux are the supported endpoints.</li>
        </ul>`,
    },
  ],
  faqs: [
    {
      q: 'Do I need root or sudo to install AirBridge on Linux?',
      a: 'No. The installer writes into your home directory (~/.local/bin, ~/Applications where relevant, and your XDG data directory) and writes a per-user launcher entry.',
    },
    {
      q: 'Which distributions are supported?',
      a: 'Releases include glibc and static musl builds for x64 and arm64, which covers mainstream distributions and older systems. Anything that can run a static arm64/x64 binary should work; the musl build is the most portable choice.',
    },
    {
      q: 'Why is the clipboard not syncing on my Linux desktop?',
      a: 'The desktop clipboard bridge needs a clipboard tool for your session: wl-clipboard on Wayland, or xclip/xsel on X11. Install one of those and AirBridge will report the bridge as supported.',
    },
    {
      q: 'Does AirBridge need systemd?',
      a: 'No. systemd is only used for the optional per-user autostart service. Without it, the installer falls back to a ~/.config/autostart entry, and you can always start AirBridge from the launcher or the CLI.',
    },
  ],
  related: ['android-to-mac-file-transfer', 'android-to-windows-file-transfer', 'android-clipboard-sync', 'open-source-airdrop-alternative'],
};

export const AIRDROP = {
  slug: 'android-airdrop-alternative',
  group: 'guide',
  shortTitle: 'Android AirDrop alternative',
  cardBlurb: 'What an AirDrop replacement for Android actually needs, and where AirBridge fits.',
  title: 'Android AirDrop Alternative: Send Files to Mac, Windows & Linux',
  description:
    'AirDrop does not work with Android. Here is what an Android AirDrop alternative needs, how AirBridge handles pairing, encryption and resumable transfers, and where it stops.',
  kicker: 'AIRDROP FOR ANDROID',
  h1: 'An AirDrop alternative for Android — and what it can honestly promise',
  lede:
    'AirDrop is Apple’s proprietary transfer feature and only works between Apple devices. Android phones need a different mechanism to reach a computer, so this page explains what a real alternative must do, how AirBridge approaches it, and which parts of the Apple experience simply cannot be replicated.',
  image: 'screenshots/desktop-calls.png',
  imageWidth: 1600,
  imageHeight: 916,
  imageAlt:
    'AirBridge desktop Calls panel with a device selector, phone battery level, a numeric keypad and a Call from phone button',
  imageCaption:
    'AirBridge goes beyond file transfer: the Calls panel on the computer mirrors the phone’s battery, offers a keypad, and can bridge call audio when you opt in.',
  sections: [
    {
      id: 'what-airdrop-is',
      h2: 'Why AirDrop cannot work with Android',
      html: `        <p>AirDrop combines Apple’s wireless discovery and a proprietary, Apple-controlled handshake. It is tied to Apple hardware and Apple’s own identity and discovery services on both ends, and it is not licensed to third parties. No third-party app can join an AirDrop session, and “AirDrop for Android” products are always their own protocol wearing a familiar name.</p>
        <p>Practical consequence: an Android user should look for a transfer tool that is honest about being cross-platform, rather than one that implies Apple interoperability it does not have.</p>`,
    },
    {
      id: 'requirements',
      h2: 'What an Android AirDrop alternative should actually provide',
      html: `        <ul>
          <li><strong>Discovery and pairing that do not need a cloud account.</strong> A QR code or short code beats “log in on both devices”.</li>
          <li><strong>Encryption you can verify.</strong> Not just “HTTPS”: a pairing step that proves both devices know the same code, plus a fingerprint you can compare.</li>
          <li><strong>Direct transport when possible.</strong> Local Wi-Fi or hotspot first, with a fallback that still keeps content encrypted.</li>
          <li><strong>Large-file handling.</strong> Multi-gigabyte videos, straight-to-disk writes, resume after a network blip, and a checksum before the file appears.</li>
          <li><strong>Real platform coverage for the computers you own</strong> — macOS, Windows and Linux, not just the phone.</li>
          <li><strong>Extras that remove round trips:</strong> clipboard sync, screen viewing, contacts and calls.</li>
        </ul>`,
    },
    {
      id: 'how-airbridge-fits',
      h2: 'How AirBridge covers those requirements',
      html: `        <p>AirBridge pairs an Android app with a desktop companion for macOS, Windows and Linux. Pairing is a QR scan or a six-character code proven with SPAKE2 (RFC 9382); the code is never transmitted, not even hashed. Session keys come from ephemeral ECDH P-256, and every chunk, clipboard item and media frame is sealed with AES-256-GCM. A six-digit SAS code lets you confirm the keys by eye.</p>
        <p>Transfers run directly between the two devices over your network. Files stream into a private <code>.part</code> journal, resume inside a running session, and are published only after the SHA-256 digest matches. If a direct path is impossible, a self-hostable relay carries ciphertext, never plaintext, and the session returns to a direct path when one appears.</p>
        <p>Beyond files, the same session carries bidirectional clipboard text (photos as well on macOS), live H.264 screen viewing that you approve per session, saved contacts, a dialer, and an optional two-way call-audio bridge. All of it is off until you enable the specific feature and grant the matching Android permission.</p>`,
    },
    {
      id: 'comparison',
      h2: 'How it compares with Apple’s built-in experience',
      html: `        <div class="table-wrap">
        <table class="compare-table">
          <caption>AirDrop versus AirBridge, stated plainly</caption>
          <thead>
            <tr><th>Capability</th><th>Apple AirDrop / Continuity</th><th class="airbridge-col">AirBridge</th></tr>
          </thead>
          <tbody>
            <tr><td><strong>Devices</strong></td><td>Apple devices only</td><td class="airbridge-col">Android ↔ macOS, Windows, Linux</td></tr>
            <tr><td><strong>Setup</strong></td><td>Nothing to install, built into the OS</td><td class="airbridge-col">Install two apps; pair once with a QR code</td></tr>
            <tr><td><strong>Encryption</strong></td><td>Apple-proprietary, opaque</td><td class="airbridge-col">SPAKE2 pairing, ECDH P-256, AES-256-GCM, verifiable SAS</td></tr>
            <tr><td><strong>Large files</strong></td><td>Handled by the OS</td><td class="airbridge-col">Direct-to-disk, resumable in-session, SHA-256 verified</td></tr>
            <tr><td><strong>iPhone support</strong></td><td>Yes</td><td class="airbridge-col">No</td></tr>
            <tr><td><strong>Polish</strong></td><td>Deep OS integration no third party can match</td><td class="airbridge-col">Native Android app plus desktop companion/CLI</td></tr>
          </tbody>
        </table>
        </div>
        <p>Read the full <a href="compare.html">honest comparison</a>, including LocalSend, KDE Connect, AirDroid, LinkMyMac and Quick Share.</p>`,
    },
    {
      id: 'install',
      h2: 'Install it and try one transfer',
      html: `        <p>macOS and Linux:</p>
        <pre><code>${SITE.installSh}</code></pre>
        <p>Windows PowerShell:</p>
        <pre><code>${SITE.installPs1}</code></pre>
        <p>Then install <a href="${SITE.apkUrl}">the Android APK</a> (installable testing/sideload build; the Play upload path is documented in <a href="${SITE.repoUrl}/blob/main/docs/PLAY_STORE_RELEASE.md">docs/PLAY_STORE_RELEASE.md</a>), scan the QR code on the computer, and confirm the six-digit code on both screens.</p>
        ${downloadAside}`,
    },
    {
      id: 'not',
      h2: 'What AirBridge is not',
      html: `        <ul>
          <li><strong>Not Apple AirDrop.</strong> It does not implement AirDrop, AWDL or any Apple protocol, and it cannot exchange files with an iPhone or iPad.</li>
          <li><strong>Not affiliated with Apple or Google.</strong> AirDrop, Continuity and iPhone Mirroring are Apple trademarks; Android, Quick Share and Google Play are Google trademarks. AirBridge is an independent project by Diganta Dey.</li>
          <li><strong>Not a cloud service.</strong> There is no AirBridge account and no server that stores your files. The optional relay forwards ciphertext and is self-hostable.</li>
          <li><strong>Not commercially licensed.</strong> The source is public and free for personal use under the AirBridge Fair-Use &amp; Non-Commercial License; commercial use needs written consent. Read <a href="${SITE.repoUrl}/blob/main/LICENSE">LICENSE</a> before you ship it anywhere.</li>
        </ul>`,
    },
  ],
  faqs: [
    {
      q: 'Does AirBridge use Apple AirDrop under the hood?',
      a: 'No. AirBridge implements its own encrypted protocol over WebSockets and WebRTC data channels. It does not use AirDrop, AWDL or any Apple-licensed technology, and it does not claim Apple interoperability.',
    },
    {
      q: 'Can I send a file from Android to an iPhone with AirBridge?',
      a: 'No. AirBridge supports Android with macOS, Windows and Linux. There is no iOS app, so Android-to-iPhone transfer is out of scope.',
    },
    {
      q: 'Do I need Bluetooth to pair?',
      a: 'No. Pairing uses a QR code or a six-character code and an encrypted network session. Bluetooth LE is used only for one optional convenience: handing phone-hotspot credentials to a Mac when there is no network connection yet.',
    },
    {
      q: 'Is AirBridge free to use?',
      a: 'It is free for personal, non-commercial use on your own devices. Commercial or organisational use requires prior written consent from the author, as described in LICENSE.',
    },
  ],
  related: ['android-to-mac-file-transfer', 'open-source-airdrop-alternative', 'compare', 'private-file-transfer'],
};
