/**
 * Continuity guides: clipboard sync, screen sharing, open-source positioning and
 * the privacy/threat-model page. Clipboard platform limits mirror
 * src/server/hostClipboard.ts (macOS text+image, Windows and Linux text only).
 */
import { SITE } from './site.mjs';

const installBlocks = `        <p>macOS and Linux:</p>
        <pre><code>${SITE.installSh}</code></pre>
        <p>Windows PowerShell:</p>
        <pre><code>${SITE.installPs1}</code></pre>`;

export const CLIPBOARD = {
  slug: 'android-clipboard-sync',
  group: 'guide',
  shortTitle: 'Android clipboard sync',
  cardBlurb: 'Text both ways, photos on macOS — without Accessibility access.',
  title: 'Android Clipboard Sync with Mac, Windows & Linux — AirBridge',
  description:
    'Copy text and photos on Android and paste them on your computer — and back. Encrypted clipboard sync with echo suppression, no Accessibility access and no account.',
  kicker: 'CLIPBOARD SYNC',
  h1: 'Clipboard sync between Android and your computer, without Accessibility workarounds',
  lede:
    'Universal Clipboard is an Apple-only feature, so copying a link on a phone and pasting it on a laptop usually means sending it to yourself. AirBridge carries clipboard text in both directions, photos from macOS to Android, and is explicit about the Android restrictions it will not bypass.',
  image: 'screenshots/phone-clipboard.png',
  imageWidth: 720,
  imageHeight: 1600,
  imageCaption:
    'The Android clipboard tab: pick a target, beam text or an image, or use Paste — with the honest note about Android’s hidden-clipboard rules.',
  imageAlt:
    'AirBridge Android clipboard screen showing a text box, Beam, Image and Paste buttons, a background sync note, and a clipboard feed with an incoming item',
  sections: [
    {
      id: 'problem',
      h2: 'Why the clipboard stops at the phone’s edge',
      html: `        <ul>
          <li><strong>Universal Clipboard requires Apple hardware</strong> and an Apple ID on both devices, so Android phones are excluded entirely.</li>
          <li><strong>Sending it to yourself</strong> means an email draft or a chat thread, an upload, a search, and a stale copy left in the cloud.</li>
          <li><strong>Vendor integrations are partial.</strong> Some manufacturer-and-PC combinations sync the clipboard, but only for those specific devices and bundled apps.</li>
          <li><strong>Android 10+ restricts background clipboard reads.</strong> Apps cannot silently read another app’s clipboard while hidden, and the workarounds some tools use — Accessibility services or notification listeners — are exactly the permissions AirBridge refuses to request.</li>
        </ul>`,
    },
    {
      id: 'how-it-works',
      h2: 'How AirBridge syncs the clipboard',
      html: `        <p>A background peer runs inside the desktop companion and inside the Android foreground service, holding the same encrypted session used for file transfers. Neither needs a browser tab open.</p>
        <ul>
          <li><strong>Computer → phone:</strong> copy text and, on macOS, copy a screenshot or photo; AirBridge captures it natively (macOS <code>NSPasteboard</code> image types) and delivers it to Android’s clipboard. Images up to about 5 MiB, text up to 256,000 characters.</li>
          <li><strong>Phone → computer:</strong> text travels both ways. On Android, send deliberately with <em>Share → AirBridge</em>, <em>Process text → AirBridge</em>, the Quick Settings tile, or the <em>Paste</em> button — or leave auto-beam on and let AirBridge capture what Android permits it to read.</li>
          <li><strong>No echo loops:</strong> SHA-256 hashes of recent clipboard payloads suppress the item bouncing back and forth between the two devices.</li>
          <li><strong>No gibberish:</strong> macOS image pasteboard types are inspected before anything is sent, so a copied photo arrives as a photo instead of a stream of scrambled bytes.</li>
        </ul>
        <p>Every item is encrypted with the same AES-256-GCM session keys as file chunks. Nothing is routed through an AirBridge server, and clipboard content is not uploaded anywhere.</p>`,
    },
    {
      id: 'limits',
      h2: 'Android clipboard limits',
      html: `        <ul>
          <li><strong>Automatic phone-side capture can be blocked by Android.</strong> If you copy text inside another app and AirBridge is in the background, the system may not let it read the clipboard. The reliable path is an explicit send: Share, Process text, the Quick Settings tile, or Paste in AirBridge. This is why AirBridge does not promise a seamless two-way mirror of every copy.</li>
          <li><strong>No Accessibility service, no notification listener.</strong> Those permissions would make background capture easier and are deliberately absent; the Play-safe permission surface is documented in <a href="${SITE.repoUrl}/blob/main/docs/PLAY_STORE_RELEASE.md">docs/PLAY_STORE_RELEASE.md</a>.</li>
          <li><strong>Password-manager clips are excluded.</strong> Payloads Android marks as sensitive are skipped rather than synced.</li>
          <li><strong>Desktop clipboard images are macOS-only.</strong> On Windows the bridge uses the built-in PowerShell clipboard cmdlets and carries text; on Linux it uses <code>wl-clipboard</code> (Wayland) or <code>xclip</code>/<code>xsel</code> (X11) and also carries text. Install one of those tools if the Linux bridge reports itself unsupported.</li>
          <li><strong>Size bounds:</strong> 512 KB of clipboard text is read per background capture on the desktop, 256,000 characters per clipboard message on the wire, and about 5 MiB per clipboard image.</li>
        </ul>`,
    },
    {
      id: 'install',
      h2: 'Turn it on',
      html: `${installBlocks}
        <p>Pair the Android app with the QR code, then open the clipboard tab on either side. <em>Auto-beam copied text</em> and <em>Receive clipboard beams</em> are separate switches, so you can choose one direction without enabling the other. If a device is untrusted, clipboard items are not delivered until you accept it.</p>`,
    },
    {
      id: 'privacy',
      h2: 'What clipboard sync keeps private',
      html: `        <p>Clipboard payloads are only decrypted on paired devices, and the history stays local — there is no clipboard account and no cloud sync. Received items can be cleared from the clipboard feed at any time. Read <a href="private-file-transfer.html">the privacy guide</a> for the full model, including what an observer on the same network can still see.</p>`,
    },
  ],
  faqs: [
    {
      q: 'Does clipboard sync work when the app or browser tab is closed?',
      a: 'Yes. The desktop companion runs a background peer that keeps the encrypted session, and the Android app uses its own foreground service for incoming items. The browser window is only the UI.',
    },
    {
      q: 'Why does copying text in another Android app not always sync automatically?',
      a: 'Android 10 and newer block hidden clipboard reads. AirBridge will not add an Accessibility service or notification listener to work around that rule, so use Share → AirBridge, Process text → AirBridge, the Quick Settings tile, or the Paste button for a deliberate send.',
    },
    {
      q: 'Can I sync clipboard photos on Windows or Linux?',
      a: 'Photo capture is implemented against macOS’s native pasteboard and is macOS-only. On Windows and Linux the desktop clipboard bridge carries text through the system clipboard tools.',
    },
    {
      q: 'Is clipboard content encrypted in transit?',
      a: 'Yes. Clipboard text and images use the same AES-256-GCM session keys as file chunks, over the paired, key-verified session. Nothing is written to an AirBridge server.',
    },
  ],
  related: ['android-to-mac-file-transfer', 'android-screen-sharing', 'private-file-transfer', 'compare'],
};

export const SCREEN = {
  slug: 'android-screen-sharing',
  group: 'guide',
  shortTitle: 'Android screen sharing',
  cardBlurb: 'Consent-based H.264 viewing of your phone on a Mac, Windows or Linux desktop.',
  title: 'Android Screen Sharing to Mac, Windows & Linux — AirBridge',
  description:
    'View your Android screen on a computer with consent-based H.264 streaming: end-to-end encrypted, approved per session, protected content stays blank, no account needed.',
  kicker: 'SCREEN SHARING',
  h1: 'View your Android screen on your computer',
  lede:
    'Showing a phone screen on a laptop usually means a Chromecast, a commercial remote-support tool, or a screenshot thread. AirBridge streams the display as low-latency H.264 over the paired, encrypted session — and only after you approve that specific session on the phone.',
  image: 'screenshots/desktop-calls.png',
  imageWidth: 1600,
  imageHeight: 916,
  imageCaption:
    'The desktop shell that hosts Contacts, Calls and Screen: the phone stays the source of the session, and every panel acts on the paired device.',
  imageAlt:
    'AirBridge desktop panel with Contacts, Calls and Screen tabs, a paired device selector, phone battery status and a dialler',
  sections: [
    {
      id: 'problem',
      h2: 'What people usually do instead',
      html: `        <ul>
          <li><strong>Cast to a TV</strong> with a Chromecast or a smart display, then photograph the screen — fine for a slide, useless for debugging an app.</li>
          <li><strong>Remote-support suites</strong> require accounts, install agents with broad permissions, and often route through a vendor cloud.</li>
          <li><strong>Screenshots in chat</strong> lose motion and timing, and leave copies behind.</li>
          <li><strong>Developer tools</strong> such as <code>adb screenrecord</code> are excellent for engineers and not a realistic option for everyone else.</li>
        </ul>`,
    },
    {
      id: 'how-it-works',
      h2: 'How the stream is built',
      html: `        <p>Android encodes the approved display with hardware <code>MediaCodec</code> H.264, caching SPS/PPS codec headers onto every keyframe and avoiding B-frames so decoding stays simple. The desktop decodes with WebCodecs using ISO 14496-15 <code>avcC</code> configuration, paces canvas draws through <code>requestAnimationFrame</code>, and asks for an instant PLI keyframe when a delta frame is lost — which keeps the picture usable on a real Wi-Fi link instead of freezing until the next scheduled keyframe.</p>
        <ul>
          <li><strong>Frame rate:</strong> about 30 fps on a healthy local network, adapting to the link.</li>
          <li><strong>Path:</strong> the same encrypted peer session as file transfers, over your network.</li>
          <li><strong>Computer ↔ computer:</strong> desktops can also share a screen or window with each other through the browser’s own screen picker, encrypted end to end.</li>
          <li><strong>Audio:</strong> optional per-session playback audio is off by default; microphone audio is never captured.</li>
        </ul>`,
    },
    {
      id: 'consent',
      h2: 'Consent, DRM and what AirBridge will not do',
      html: `        <ul>
          <li><strong>Two approvals per session:</strong> an in-app confirmation on Android plus Android’s own MediaProjection prompt. The device being shared can stop the stream, and so can the viewer.</li>
          <li><strong>Protected content stays blank.</strong> Apps that set <code>FLAG_SECURE</code> — banking, Netflix, DRM video — appear black by design. AirBridge does not classify apps, bypass protected surfaces, or extract protected audio.</li>
          <li><strong>Viewing only.</strong> There is no tap, swipe or keyboard injection. AirBridge is not a remote-control tool.</li>
          <li><strong>Not a recorder.</strong> A share is a live view; there is no recording feature in AirBridge.</li>
        </ul>`,
    },
    {
      id: 'install',
      h2: 'Try it',
      html: `${installBlocks}
        <p>Pair the phone, open <em>Screen</em> on the computer, and approve the request on Android. The phone battery level is shown in the panel so you know when to plug in during a long demo.</p>`,
    },
    {
      id: 'limits',
      h2: 'Screen sharing limits',
      html: `        <ul>
          <li><strong>Latency is your network’s latency.</strong> A congested 2.4 GHz link or a battery-saver throttle shows up as fewer frames; AirBridge does not claim a fixed millisecond budget.</li>
          <li><strong>No audio unless you opt in per session</strong>, and only where Android permits playback capture.</li>
          <li><strong>Some apps opt out</strong> of capture entirely and will be blank or silent; that is the platform working as designed.</li>
          <li><strong>Screen-off is not a supported mode</strong> for watching a display; the phone screen drives the stream.</li>
        </ul>`,
    },
  ],
  faqs: [
    {
      q: 'Can I watch my Android screen on a Mac without a Chromecast?',
      a: 'Yes. The macOS companion receives a consent-based H.264 stream over the paired connection; no casting device or account is involved. Windows and Linux companions receive the same stream.',
    },
    {
      q: 'Does screen sharing include audio?',
      a: 'Only if you enable it for that session. Playback audio is off by default and depends on Android and the source app allowing capture. Microphone audio is never captured.',
    },
    {
      q: 'Can I control the phone from the computer?',
      a: 'No. AirBridge shares a view of the screen and does not inject input. Tools that do that require different permissions and a different threat model.',
    },
    {
      q: 'Why is my banking or streaming app showing a black screen?',
      a: 'Those apps set FLAG_SECURE, which tells Android the content must not be captured. AirBridge respects it and shows blank frames rather than attempting to bypass DRM or protected surfaces.',
    },
    {
      q: 'Is the stream recorded anywhere?',
      a: 'No. AirBridge has no recording feature; the frames are decoded for a live view and are not written to disk.',
    },
  ],
  related: ['android-clipboard-sync', 'android-to-mac-file-transfer', 'private-file-transfer', 'compare'],
};

export const OPEN_SOURCE = {
  slug: 'open-source-airdrop-alternative',
  group: 'guide',
  shortTitle: 'Open-source AirDrop alternative',
  cardBlurb: 'Auditable code, a self-hostable relay and an honest note about the licence.',
  title: 'Open-Source AirDrop Alternative for Android and Computers — AirBridge',
  description:
    'AirBridge is a source-available AirDrop alternative for Android, macOS, Windows and Linux: auditable encryption, a self-hostable relay, no accounts — and an honest licence note.',
  kicker: 'OPEN SOURCE',
  h1: 'Looking for an open-source AirDrop alternative? Start with the licence',
  lede:
    'Open source matters most where it is least convenient: the pairing protocol, the encryption, the update path, and the licence that governs whether you may use it at work. Here is what AirBridge publishes, what you can verify yourself, and what the licence actually says.',
  image: 'screenshots/desktop-clipboard.png',
  imageWidth: 1600,
  imageHeight: 905,
  imageCaption:
    'The desktop companion ships in the same repository as the Android app, the server and the CLI — so the UI you audit matches the protocol you audit.',
  imageAlt:
    'AirBridge desktop clipboard panel with auto-beam and receive options, a send box and recent clipboard beams',
  sections: [
    {
      id: 'what-open-means',
      h2: 'AirBridge’s source and licence',
      html: `        <p>The full source is public on GitHub: the TypeScript server, the React client, the Kotlin Android app and engine, the Swift menu-bar shell, the CLI, the installers and the release workflows. Anyone can read the pairing protocol, the AES-GCM framing and the TLS pinning code, and run the test suite.</p>
        <p><strong>The licence is not an OSI-approved licence.</strong> AirBridge uses a Fair-Use &amp; Non-Commercial licence: free for personal, non-commercial use on your own devices, with commercial or organisational use requiring prior written consent from the author. If your definition of open source requires OSI approval, this project does not meet it — <a href="${SITE.repoUrl}/blob/main/LICENSE">LICENSE</a> is short and worth reading before you rely on it.</p>`,
    },
    {
      id: 'why-it-matters',
      h2: 'Why the source being public matters for a transfer tool',
      html: `        <ul>
          <li><strong>You can check the cryptography instead of trusting a badge.</strong> SPAKE2 (RFC 9382) pairing, HKDF key derivation, AES-256-GCM chunk and frame encryption, SHA-256 pre-publication checks and the SAS verification flow are all in the repository.</li>
          <li><strong>You can see what is not collected.</strong> The Android app ships no advertising or analytics SDK, and the desktop diagnostics are scrubbed, bounded and only shared when you click.</li>
          <li><strong>You can self-host the fallback.</strong> When a direct path is impossible, the relay is <code>airbridge relay</code> — run it on a box you control, and it still only ever sees ciphertext.</li>
          <li><strong>You can build the binaries yourself</strong> from the same workflow definitions that produce the release artefacts, and compare checksums or Sigstore attestations.</li>
          <li><strong>You are not locked in.</strong> Pairing state, files and clipboard history live on your devices.</li>
        </ul>`,
    },
    {
      id: 'alternatives',
      h2: 'Where AirBridge sits among open-source transfer tools',
      html: `        <p>There is no single winner; the right tool depends on the devices in front of you.</p>
        <ul>
          <li><strong>LocalSend</strong> is MIT-licensed, cross-platform and wonderfully simple. If you only need to move files between devices that all run LocalSend, and a permissive licence matters to you or your employer, it is an excellent choice.</li>
          <li><strong>KDE Connect</strong> is GPL-licensed and deeply integrated with KDE Plasma, including notification mirroring and remote input. On a Plasma desktop it is hard to beat; AirBridge focuses on Android ↔ macOS/Windows/Linux with its own encrypted pairing protocol.</li>
          <li><strong>PairDrop / Snapdrop-style browser tools</strong> need no installation at all, which is their strength — and their limit, since a browser tab cannot own a background session, a native clipboard or a system screen capture.</li>
          <li><strong>AirBridge</strong> targets the case where an Android phone and a Mac, Windows PC or Linux box must exchange multi-gigabyte files, clipboard items, a screen view, contacts and calls inside one verified session — with a CLI and daemon for automation.</li>
        </ul>
        <p>The full side-by-side, including commercial options, is on the <a href="compare.html">comparison page</a>.</p>`,
    },
    {
      id: 'verify',
      h2: 'How to verify a download',
      html: `        <p>Every release publishes <code>SHA256SUMS.txt</code> and keyless Sigstore build-provenance attestations. The desktop installer and self-updater enforce the checksums before installing anything.</p>
        <pre><code>gh attestation verify AirBridge-linux-x64 -R DigantaDey/AirBridge</code></pre>
        <p>${downloadBlocksInline()}</p>`,
    },
    {
      id: 'contribute',
      h2: 'Contributing back',
      html: `        <p>Bug reports, device-specific findings and documentation fixes are genuinely useful — especially reports from OEM Android builds, because background behaviour varies. Start with <a href="${SITE.repoUrl}/blob/main/CONTRIBUTING.md">CONTRIBUTING.md</a>, follow the <a href="${SITE.repoUrl}/blob/main/CODE_OF_CONDUCT.md">code of conduct</a>, and use the issue templates so a report includes the version and platform details that make it actionable.</p>
        <p>Security issues should not be filed publicly: the process is in <a href="${SITE.repoUrl}/blob/main/SECURITY.md">SECURITY.md</a>.</p>`,
    },
  ],
  faqs: [
    {
      q: 'Is AirBridge OSI-approved open source?',
      a: 'No. The source is public, but the licence is a Fair-Use & Non-Commercial licence rather than an OSI-approved one. Personal use is free; commercial or organisational use needs written consent from the author.',
    },
    {
      q: 'Can I use AirBridge at work?',
      a: 'Commercial, corporate or monetised use requires prior written consent from the author, per LICENSE. For personal devices the software is free.',
    },
    {
      q: 'Can I self-host the relay?',
      a: 'Yes. airbridge relay --listen 0.0.0.0:47391 runs the relay on hardware you control, and computers can point at it with airbridge --relay. The relay forwards ciphertext; it does not receive session keys.',
    },
    {
      q: 'Has the code been independently audited?',
      a: 'No third-party audit is claimed. The project publishes its own threat model and audit notes in SECURITY.md, and the cryptography is implemented with audited primitives (@noble/curves, @noble/hashes) inside readable TypeScript and Kotlin.',
    },
    {
      q: 'Can I fork it and publish my own build?',
      a: 'The licence governs redistribution, and commercial use needs written consent. For personal experiments, the repository is complete: server, clients, Android app, installers and release workflows are all included.',
    },
  ],
  related: ['android-airdrop-alternative', 'private-file-transfer', 'compare', 'android-to-linux-file-transfer'],
};

export const PRIVATE = {
  slug: 'private-file-transfer',
  group: 'guide',
  shortTitle: 'Private file transfer',
  cardBlurb: 'No account, no cloud copy — and an honest list of what can still be observed.',
  title: 'Private, Encrypted File Transfer Between Phone and Computer — AirBridge',
  description:
    'How AirBridge keeps transfers private: no account, no cloud copy, SPAKE2 pairing, AES-256-GCM payloads, SHA-256 verification and redacted, opt-in diagnostics.',
  kicker: 'PRIVACY & SECURITY',
  h1: 'Private file transfer between your phone and your computer',
  lede:
    'A private transfer means three things at once: the content is encrypted end to end, no third party keeps a copy, and you are told honestly what can still be observed. AirBridge is designed around all three, so this page lists both the protections and the limits.',
  sections: [
    {
      id: 'model',
      h2: 'The model, in plain terms',
      html: `        <ul>
          <li><strong>No account.</strong> There is nothing to sign up for, no identity server, and no device directory outside your own network.</li>
          <li><strong>No cloud copy.</strong> Files are streamed between the two devices. The only optional server is a relay you can run yourself, and it forwards ciphertext.</li>
          <li><strong>End-to-end encryption.</strong> Pairing is proven with SPAKE2 (RFC 9382); session keys come from ephemeral ECDH P-256 with HKDF; file chunks, clipboard items, call audio and screen frames are sealed with AES-256-GCM.</li>
          <li><strong>Verified before saved.</strong> A received file is published only when its SHA-256 digest matches what the sender declared.</li>
          <li><strong>No analytics in the app.</strong> The Android app contains no advertising or analytics SDK, and the marketing site is a static page with no tracking scripts.</li>
        </ul>`,
    },
    {
      id: 'threat-model',
      h2: 'What an observer can still see',
      html: `        <p>Honest privacy writing names the gaps. Before pairing, devices on the same network can see that an AirBridge device exists, its device name and its public key — discovery is not trust. The network operator (or anyone who can watch the link) can see addresses, ports, timing and rough volume, even though the payload is ciphertext. A relay sees connection metadata and ciphertext, never session keys.</p>
        <p>The pairing code itself is never transmitted, not even as a hash, and pairing attempts are rate-limited, so guessing the code is not a practical way in. A six-digit SAS code and a pinned TLS certificate authority let you detect a substituted key on first contact.</p>`,
    },
    {
      id: 'host-boundary',
      h2: 'The computer is a separate trust boundary',
      html: `        <p>The desktop service exposes host-level actions — writing the system clipboard, saving into the receive folder, revealing a file, opening a folder — only on loopback. A paired phone cannot ask your computer to run a shell command. Folder-open requests are constrained to the configured receive folder and use a fixed argument vector, not a shell.</p>
        <p>On the Android side, the app declares no Accessibility service and no notification listener, requests no call-log permission, and disables Android backup so pairing state and TLS pins stay on the device. Every continuity permission — contacts, phone, microphone, screen capture — is off until you enable that specific feature.</p>`,
    },
    {
      id: 'diagnostics',
      h2: 'Diagnostics, crash reports and what leaves your device',
      html: `        <p>Diagnostics stay local. Bundles are bounded, and personal data is redacted — home paths and usernames, IP and MAC addresses, Wi-Fi SSIDs, pairing codes, tokens and cryptographic keys. Nothing is uploaded automatically: a report is only shared when you review it and click <strong>Copy diagnostics</strong>, <strong>Report on GitHub</strong> or <strong>Send report</strong>. The <a href="privacy.html">privacy policy</a> lists this in the same detail.</p>`,
    },
    {
      id: 'limits',
      h2: 'Limits and disclosures',
      html: `        <ul>
          <li><strong>No independent audit.</strong> The project publishes its own threat model and audit notes in <a href="${SITE.repoUrl}/blob/main/SECURITY.md">SECURITY.md</a>; it does not claim a third-party audit or absolute-security guarantees.</li>
          <li><strong>Ad-hoc signed macOS binaries</strong> and unsigned Windows binaries mean Gatekeeper and SmartScreen friction; integrity comes from published checksums and Sigstore attestations rather than paid certificates.</li>
          <li><strong>Screen sharing respects DRM</strong> and stays blank for protected content, and call audio routing uses an opt-in, speakerphone-assisted bridge because unrooted Android restricts raw cellular uplink injection.</li>
          <li><strong>Local threats remain.</strong> A compromised device, malware with screen access, or someone who can read your unlocked phone are outside any app’s threat model.</li>
        </ul>`,
    },
    {
      id: 'verify',
      h2: 'Verify a release, verify a device',
      html: `        <pre><code>gh attestation verify AirBridge-macOS-arm64.zip -R DigantaDey/AirBridge</code></pre>
        <p>For the device side: compare the six-digit verification code on first pairing, keep an eye on the trusted-device list, and use <strong>Forget</strong> on the phone if a pinned certificate ever changes unexpectedly. A TLS error is never permission to downgrade to plaintext.</p>`,
    },
  ],
  faqs: [
    {
      q: 'Does AirBridge store my files anywhere?',
      a: 'No. Files are streamed between the paired devices and written to the receive folder you configured. There is no AirBridge account or storage service.',
    },
    {
      q: 'Does the relay see file contents?',
      a: 'No. The relay forwards ciphertext inside an end-to-end TLS session that stays pinned between the devices. It can observe connection metadata such as addresses and timing, as any network hop can.',
    },
    {
      q: 'Is there telemetry or analytics?',
      a: 'The Android app ships no advertising or analytics SDK, and the static website does not load tracking scripts. Diagnostics are generated locally and only shared when you click a share action.',
    },
    {
      q: 'Has AirBridge been audited by a third party?',
      a: 'No. The maintainer publishes the threat model and audit notes in SECURITY.md, and the cryptographic primitives are audited libraries, but there is no independent third-party audit and the site does not claim one.',
    },
  ],
  related: ['open-source-airdrop-alternative', 'android-clipboard-sync', 'android-to-mac-file-transfer', 'compare'],
};

function downloadBlocksInline() {
  return `The release page also lists the per-platform assets: <code>AirBridge-macOS-arm64.zip</code>, <code>AirBridge-macOS-x64.zip</code>, <code>AirBridge-windows-x64.exe</code>, <code>AirBridge-windows-arm64.exe</code>, <code>AirBridge-linux-x64</code>, <code>AirBridge-linux-arm64</code> and their musl variants, plus <code>AirBridge-android-debug.apk</code>.`;
}
