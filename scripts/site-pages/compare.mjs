/**
 * Honest comparison page. Competitor statements are deliberately conservative
 * and hedged: capabilities and licences change, and readers are told to check
 * each project's own documentation.
 */
import { SITE } from './site.mjs';

export const COMPARE = {
  slug: 'compare',
  group: 'page',
  shortTitle: 'Honest comparison',
  cardBlurb: 'AirBridge next to LocalSend, KDE Connect, AirDroid, LinkMyMac, Quick Share and AirDrop.',
  title: 'AirBridge vs LocalSend, KDE Connect, AirDroid, LinkMyMac & Quick Share',
  description:
    'An honest comparison of AirBridge with LocalSend, KDE Connect, AirDroid, LinkMyMac, Quick Share and Apple AirDrop — including where another tool is the better choice.',
  kicker: 'COMPARISON',
  h1: 'Compare AirBridge with other transfer apps',
  lede:
    'Every tool on this page is good at something. This comparison is written to help you pick, not to win a table: it separates what AirBridge does from what other projects do better, and it says where AirBridge is the wrong answer.',
  sections: [
    {
      id: 'how-to-read',
      h2: 'How to read this comparison',
      html: `        <p>Features and licences in this space change often, so treat the table as a starting point and confirm details with each project’s own documentation. AirBridge rows describe the current release (v${SITE.version}) and come from this repository; competitor rows describe the general shape of each product, not a specific version.</p>
        <p>None of these tools is invulnerable, and none is a substitute for device security. AirBridge makes no claim to be audited by a third party; it publishes its own threat model in <a href="${SITE.repoUrl}/blob/main/SECURITY.md">SECURITY.md</a>.</p>`,
    },
    {
      id: 'table',
      h2: 'Capability comparison',
      html: `        <div class="table-wrap">
          <table class="compare-table">
            <thead>
              <tr>
                <th>Capability</th>
                <th class="airbridge-col">AirBridge</th>
                <th>LocalSend</th>
                <th>KDE Connect</th>
                <th>AirDroid</th>
                <th>LinkMyMac</th>
                <th>Quick Share</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Primary platforms</strong></td>
                <td class="airbridge-col">Android ↔ macOS, Windows, Linux (+ CLI)</td>
                <td>Desktop + mobile apps for many OSes</td>
                <td>Linux/KDE first, Android; other desktops unofficial</td>
                <td>Android + web dashboard + desktop apps</td>
                <td>macOS ↔ Android</td>
                <td>Android, Windows, ChromeOS and some others</td>
              </tr>
              <tr>
                <td><strong>Licence</strong></td>
                <td class="airbridge-col">Source public; non-commercial fair-use licence</td>
                <td>Permissive open-source licence</td>
                <td>GPL-family open source</td>
                <td>Proprietary</td>
                <td>Proprietary, commercial</td>
                <td>Proprietary</td>
              </tr>
              <tr>
                <td><strong>Account required</strong></td>
                <td class="airbridge-col">No</td>
                <td>No</td>
                <td>No</td>
                <td>Yes (for most features)</td>
                <td>Licence, not an account, typically</td>
                <td>Google account for some features</td>
              </tr>
              <tr>
                <td><strong>File transport</strong></td>
                <td class="airbridge-col">Direct LAN; optional self-hostable relay</td>
                <td>Direct LAN</td>
                <td>Direct LAN</td>
                <td>Vendor cloud/relay, LAN where possible</td>
                <td>Direct/local connection</td>
                <td>Direct nearby connection</td>
              </tr>
              <tr>
                <td><strong>Encryption model</strong></td>
                <td class="airbridge-col">SPAKE2 pairing, ECDH P-256, AES-256-GCM, SAS verification</td>
                <td>Encrypted transport between apps</td>
                <td>Encrypted transport between apps</td>
                <td>Vendor-managed accounts and encryption</td>
                <td>Vendor-managed</td>
                <td>Vendor-managed</td>
              </tr>
              <tr>
                <td><strong>Resume large transfers</strong></td>
                <td class="airbridge-col">In-session resume with <code>.part</code> journal and SHA-256 check</td>
                <td>Varies; restart is common</td>
                <td>Varies; restart is common</td>
                <td>Varies</td>
                <td>Varies</td>
                <td>Varies</td>
              </tr>
              <tr>
                <td><strong>Clipboard sync</strong></td>
                <td class="airbridge-col">Text both ways; photos from macOS</td>
                <td>Manual text/file send</td>
                <td>Text sync between paired devices</td>
                <td>Clipboard features on paid tiers</td>
                <td>Yes</td>
                <td>Not a general clipboard sync</td>
              </tr>
              <tr>
                <td><strong>View the phone screen</strong></td>
                <td class="airbridge-col">Yes — consent-based H.264, view only</td>
                <td>No</td>
                <td>Limited/experimental depending on build</td>
                <td>Yes, including remote control on paid tiers</td>
                <td>Yes, mirroring</td>
                <td>No</td>
              </tr>
              <tr>
                <td><strong>Contacts &amp; calls from the computer</strong></td>
                <td class="airbridge-col">Contacts, dialler, call notifications, optional call audio</td>
                <td>No</td>
                <td>Call notifications, no audio bridge</td>
                <td>Notifications and SMS on paid tiers</td>
                <td>Notifications and calls</td>
                <td>No</td>
              </tr>
              <tr>
                <td><strong>CLI / daemon / automation</strong></td>
                <td class="airbridge-col">Yes — <code>npx airbridge</code>, daemon, self-hosted relay</td>
                <td>No official CLI</td>
                <td>CLI helpers</td>
                <td>No</td>
                <td>No</td>
                <td>No</td>
              </tr>
              <tr>
                <td><strong>iOS support</strong></td>
                <td class="airbridge-col">No</td>
                <td>Yes</td>
                <td>Limited</td>
                <td>Yes</td>
                <td>No (Android side)</td>
                <td>Varies</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="guide-note">Rows for other products are deliberately general. Verify the current feature list, licence and pricing with each vendor or project before you commit.</p>`,
    },
    {
      id: 'airbridge-strengths',
      h2: 'When to use AirBridge',
      html: `        <ul>
          <li><strong>Android plus a Mac, without an account.</strong> That combination is the gap AirBridge was built for: Apple’s tools exclude Android, and most Android-first tools treat macOS as a second-class client.</li>
          <li><strong>One verified session for several jobs.</strong> Files, clipboard, screen view, contacts and calls share the same pairing and the same encryption, instead of five different tools and three accounts.</li>
          <li><strong>Large, boring transfers that finish.</strong> Direct-to-disk writes, in-session resume, SHA-256 verification before the file appears, and up to 100 files per batch.</li>
          <li><strong>Inspectable and self-hostable.</strong> The protocol is readable in the repository, and the relay that handles awkward networks is a command you can run yourself.</li>
          <li><strong>Automation.</strong> A CLI, a daemon and a relay make it usable on headless machines and in scripts, which GUI-only tools cannot offer.</li>
          <li><strong>Honest permission surface.</strong> No Accessibility service, no notification listener, no call-log permission, no Android backup of pairing state.</li>
        </ul>`,
    },
    {
      id: 'choose-something-else',
      h2: 'Where another tool is the better choice',
      html: `        <ul>
          <li><strong>You need a permissive licence for work.</strong> LocalSend’s permissively licensed codebase is the safer choice for company devices and redistribution; AirBridge’s Fair-Use licence requires written consent for commercial use.</li>
          <li><strong>You live in KDE Plasma.</strong> KDE Connect’s desktop integration — notification mirroring, remote input, Plasma applets — goes further than AirBridge on a Linux desktop, and it is GPL.</li>
          <li><strong>You need remote management over the internet.</strong> AirDroid’s web dashboard, remote control and SMS tools exist precisely for “my phone is somewhere else”. AirBridge is for devices near each other or reachable through your own relay.</li>
          <li><strong>You want a commercial product with support.</strong> LinkMyMac and similar paid apps offer vendor support and a financed roadmap; AirBridge is a one-person open project.</li>
          <li><strong>You just need Windows ↔ Android nearby sharing.</strong> Quick Share is already installed and needs no setup at all — if files are the only requirement, use what is on the device.</li>
          <li><strong>Everything you own is Apple.</strong> AirDrop and Continuity are deeply integrated in ways no third-party app can match. AirBridge exists for the mixed Android + desktop case.</li>
          <li><strong>You need iOS in the mix.</strong> AirBridge has no iOS client; choose a tool that does.</li>
        </ul>`,
    },
    {
      id: 'disclosure',
      h2: 'AirBridge’s limitations',
      html: `        <ul>
          <li><strong>No iOS, no browser-based account, no cloud.</strong> That is the design, and it is also a real limitation for some workflows.</li>
          <li><strong>The licence is not OSI-approved.</strong> Source is public, but commercial use needs written consent. See <a href="${SITE.repoUrl}/blob/main/LICENSE">LICENSE</a>.</li>
          <li><strong>Binaries are not covered by paid signing certificates</strong> — ad-hoc signed on macOS, unsigned on Windows — so macOS may need a right-click → Open for browser downloads and Windows may show SmartScreen. Checksums and Sigstore attestations are published instead.</li>
          <li><strong>Android restricts background clipboard reads</strong>, and AirBridge refuses the Accessibility workarounds other tools use. Explicit Share/Process text/Paste actions are the reliable path.</li>
          <li><strong>No third-party security audit is claimed.</strong> The maintainer’s own review is public in <a href="${SITE.repoUrl}/blob/main/SECURITY.md">SECURITY.md</a>.</li>
        </ul>
        <p>If those trade-offs work for you, <a href="download.html">install AirBridge</a> and read the <a href="private-file-transfer.html">privacy guide</a>. If they do not, one of the alternatives above will serve you better — and that is a perfectly good outcome.</p>`,
    },
  ],
  faqs: [
    {
      q: 'Is AirBridge better than LocalSend?',
      a: 'Not universally. LocalSend is permissively licensed, supports iOS, and is very simple to use. AirBridge adds an Android-focused desktop companion with clipboard sync, screen viewing, contacts and calls inside one verified session — at the cost of a non-commercial licence and no iOS app.',
    },
    {
      q: 'Does AirBridge replace KDE Connect?',
      a: 'Only partly. KDE Connect is deeper inside KDE Plasma (notification mirroring, remote input, applets). AirBridge focuses on Android ↔ macOS/Windows/Linux with its own encrypted pairing, resumable transfers and screen streaming.',
    },
    {
      q: 'Can AirBridge replace AirDroid?',
      a: 'For nearby files, clipboard and screen viewing, often yes. If you need remote management over the internet, web dashboards or SMS tools from a browser, AirDroid’s cloud model covers more of that workflow.',
    },
    {
      q: 'Why is Quick Share not enough?',
      a: 'Quick Share is excellent for nearby file transfer on the devices that support it, but it does not give you clipboard sync, screen viewing, contacts or calls on a Mac or Linux machine. Use both: Quick Share when it is already there, AirBridge when you need the rest.',
    },
  ],
  related: ['android-airdrop-alternative', 'open-source-airdrop-alternative', 'private-file-transfer', 'download'],
};
