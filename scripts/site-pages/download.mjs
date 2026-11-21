/** Download and installation page — mirrors docs/DISTRIBUTION.md asset names exactly. */
import { SITE } from './site.mjs';

export const DOWNLOAD = {
  slug: 'download',
  group: 'page',
  shortTitle: 'Download & install',
  cardBlurb: 'Official builds for macOS, Windows, Linux and Android, plus checksums.',
  title: 'Download AirBridge — Android, macOS, Windows & Linux',
  description:
    'Download AirBridge: prebuilt macOS app, portable Windows EXE, static Linux binaries, the Android APK and the CLI. Verify every file with SHA256SUMS.txt or Sigstore.',
  kicker: 'INSTALL',
  h1: 'Download AirBridge',
  lede:
    'Every official build comes from the same public GitHub release: a macOS app, a portable Windows executable, static Linux binaries for x64 and arm64, an Android APK and the CLI. There is no store account, no purchase and no trial to activate — and every artefact ships with a checksum you can verify.',
  sections: [
    {
      id: 'platforms',
      h2: 'Pick your platform',
      html: `        <div class="table-wrap">
          <table class="compare-table">
            <thead>
              <tr><th>Platform</th><th>Artifact</th><th>Install</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>macOS</strong><br>Apple silicon &amp; Intel</td>
                <td><code>AirBridge-macOS-arm64.zip</code><br><code>AirBridge-macOS-x64.zip</code><br><code>AirBridge-darwin-arm64</code> / <code>-x64</code></td>
                <td>One-line <code>install.sh</code>, or unzip the app bundle. Ad-hoc signed.</td>
              </tr>
              <tr>
                <td><strong>Windows</strong><br>x64 &amp; ARM64</td>
                <td><code>AirBridge-windows-x64.exe</code><br><code>AirBridge-windows-arm64.exe</code></td>
                <td>One-line <code>install.ps1</code>, or run the portable EXE anywhere. No admin rights.</td>
              </tr>
              <tr>
                <td><strong>Linux</strong><br>x64 &amp; arm64, glibc or musl</td>
                <td><code>AirBridge-linux-x64</code><br><code>AirBridge-linux-arm64</code><br><code>AirBridge-linux-x64-musl</code><br><code>AirBridge-linux-arm64-musl</code></td>
                <td>One-line <code>install.sh</code> (no root), or run the static binary. Adds an XDG launcher entry.</td>
              </tr>
              <tr>
                <td><strong>Android</strong><br>8.0 (API 26)+</td>
                <td><code>AirBridge-android-debug.apk</code></td>
                <td>Google Play Store app — coming soon. For now, sideload the APK, then pair with the desktop QR code.</td>
              </tr>
              <tr>
                <td><strong>iPhone / iPad</strong></td>
                <td>Safari browser UI; no native iOS app</td>
                <td>Open the address shown by your running AirBridge computer. File transfer and clipboard sharing depend on browser permissions. Screen sharing, contacts and calls are not promised on iOS. The local HTTPS certificate may trigger a CA trust warning: only continue after verifying the address belongs to your own instance.</td>
              </tr>
              <tr>
                <td><strong>Any OS with Node 20+</strong></td>
                <td><code>npx airbridge</code> / source checkout</td>
                <td>Run the CLI, daemon, relay and browser UI without a prebuilt binary.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="guide-actions">
          <a class="button button-dark" href="${SITE.releasesUrl}">Open the latest release <svg class="icon" aria-hidden="true"><use href="#arrow"/></svg></a>
          <a class="button button-secondary" href="${SITE.apkUrl}">Android APK</a>
        </p>`,
    },
    {
      id: 'commands',
      h2: 'Install with one command',
      html: `        <p><strong>macOS &amp; Linux</strong> — installs the app and the <code>AirBridge</code> command, no sudo:</p>
        <pre><code>${SITE.installSh}</code></pre>
        <p><strong>Windows PowerShell</strong> — user-scope install into <code>%LOCALAPPDATA%\\AirBridge</code>:</p>
        <pre><code>${SITE.installPs1}</code></pre>
        <p>Both installers download over HTTPS and check the file against the release’s <code>SHA256SUMS.txt</code> before anything runs. Add <code>--autostart</code> (or <code>-Autostart</code> on Windows) to start AirBridge at login.</p>`,
    },
    {
      id: 'stable-vs-dev',
      h2: 'Stable releases vs development builds',
      html: `        <ul>
          <li><strong>Stable:</strong> the latest <a href="${SITE.releasesUrl}">GitHub release</a> (tagged <code>v${SITE.version}</code> today). This is what the installers and the desktop self-updater use. Updates reach computers gradually — 10%, 50%, then 100% — and a bad release can be paused.</li>
          <li><strong>Development:</strong> builds from <code>main</code> and CI workflow artefacts. Useful for testing a fix, not for a machine you rely on. Build one yourself with <code>npm ci &amp;&amp; npm run build:desktop</code>.</li>
          <li><strong>Android:</strong> the published APK is an installable testing/sideload build produced by the release workflow. The Play-ready App Bundle is a separate, signed upload path gated on a private key — see <a href="${SITE.repoUrl}/blob/main/docs/PLAY_STORE_RELEASE.md">docs/PLAY_STORE_RELEASE.md</a>. No unsigned substitute is ever published as a “release”.</li>
        </ul>`,
    },
    {
      id: 'verify',
      h2: 'Verify what you downloaded',
      html: `        <p>Every release includes <code>SHA256SUMS.txt</code> and keyless Sigstore build-provenance attestations:</p>
        <pre><code>sha256sum --check SHA256SUMS.txt
gh attestation verify AirBridge-linux-x64 -R DigantaDey/AirBridge</code></pre>
        <p>The macOS and Windows binaries are not signed with paid vendor certificates: the macOS app is ad-hoc signed (so Apple silicon will run it) and the Windows EXE is unsigned. Checksums, attestations and the self-updater’s own verification are the integrity story, and they are documented in <a href="${SITE.repoUrl}/blob/main/docs/DISTRIBUTION.md">docs/DISTRIBUTION.md</a>.</p>`,
    },
    {
      id: 'requirements',
      h2: 'Requirements and ports',
      html: `        <ul>
          <li><strong>Android 8.0 (API 26) or newer</strong> for the phone app.</li>
          <li><strong>macOS</strong> with Apple silicon or Intel, <strong>Windows</strong> x64 or ARM64, or <strong>Linux</strong> x64/arm64 on glibc or musl. Prebuilt binaries need no Node.js.</li>
          <li><strong>Building from source</strong> needs Node.js 20+, npm and Git; Android builds need JDK 17, Gradle and Android SDK 35.</li>
          <li><strong>Network:</strong> phone and computer on the same Wi-Fi (or the phone’s hotspot). The service listens on port 3000 by default — set <code>PORT</code> to change it, and allow the app through the Windows firewall for private networks.</li>
        </ul>`,
    },
    {
      id: 'docs',
      h2: 'Documentation and source',
      html: `        <ul>
          <li><a href="${SITE.repoUrl}#readme">README</a> — capabilities, architecture, environment variables and CLI examples.</li>
          <li><a href="${SITE.repoUrl}/blob/main/docs/pairing-and-connectivity.md">Pairing and connectivity</a> — protocols, threat model and the manual test plan.</li>
          <li><a href="${SITE.repoUrl}/blob/main/docs/desktop-runtime.md">Desktop runtime</a> — the self-updater, rollout and rollback behaviour.</li>
          <li><a href="${SITE.repoUrl}/blob/main/docs/ANDROID_VALIDATION.md">Android validation checklist</a> — background behaviour, OEM battery rules and real-device testing.</li>
          <li><a href="${SITE.repoUrl}/blob/main/SECURITY.md">Security notes</a> and <a href="privacy.html">privacy policy</a>.</li>
        </ul>
        <p>Reading the code before installing is encouraged: <a href="${SITE.repoUrl}">github.com/DigantaDey/AirBridge</a>.</p>`,
    },
  ],
  faqs: [
    {
      q: 'Which macOS file should I download on an Apple silicon Mac?',
      a: 'AirBridge-macOS-arm64.zip (or AirBridge-darwin-arm64 for the bare binary). Use the x64 files on Intel Macs. The install.sh script picks the right build automatically.',
    },
    {
      q: 'Do I need Node.js to run AirBridge?',
      a: 'No. The macOS app, Windows EXE and Linux binaries embed everything. Node.js 20+ is only needed to build from source or to use npx airbridge.',
    },
    {
      q: 'Why is AirBridge not on the App Store or the Microsoft Store?',
      a: 'Store distribution needs paid developer accounts. AirBridge distributes ad-hoc signed macOS builds and unsigned Windows executables from GitHub instead, and publishes checksums plus Sigstore attestations so you can verify them.',
    },
    {
      q: 'Is the Android APK a Play Store build?',
      a: 'It is an installable testing/sideload build produced by the release workflow. The Play-ready App Bundle is built separately and fails closed unless a private upload key is configured, as documented in docs/PLAY_STORE_RELEASE.md.',
    },
  ],
  related: ['android-to-mac-file-transfer', 'android-to-windows-file-transfer', 'android-to-linux-file-transfer', 'compare'],
};
