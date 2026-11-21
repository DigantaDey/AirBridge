/**
 * Content for the generated airbridge.fyi pages.
 *
 * Every claim in these pages is taken from the repository itself (README,
 * docs/, SECURITY.md and the source in src/ and android/). When a limit is
 * real — no native iOS app, ad-hoc signing, Android clipboard restrictions — it is
 * stated plainly on the page instead of being hidden.
 */
import { MAC, WINDOWS, LINUX, AIRDROP } from './guides-desktop.mjs';
import { CLIPBOARD, SCREEN, OPEN_SOURCE, PRIVATE } from './guides-continuity.mjs';
import { DOWNLOAD } from './download.mjs';
import { COMPARE } from './compare.mjs';
import { SITE } from './site.mjs';

export { SITE };

export const GUIDES_HUB = {
  slug: 'guides',
  group: 'hub',
  shortTitle: 'All guides',
  cardBlurb: 'Every AirBridge guide in one place.',
  title: 'AirBridge guides — Android to Mac, Windows & Linux connectivity',
  description:
    'Practical guides for moving files from Android to a computer, syncing the clipboard, sharing your phone screen, and understanding AirBridge’s encryption, permissions and honest limits.',
  kicker: 'AIRBRIDGE',
  h1: 'AirBridge guides: Android ↔ Mac, Windows and Linux, explained',
  lede:
    'AirBridge connects an Android phone to a desktop computer without an account, a cloud drive or a proprietary protocol. These guides explain how each capability works, what it needs on your machine, and where the honest limits are.',
};

export const PAGES = [
  DOWNLOAD,
  MAC,
  WINDOWS,
  LINUX,
  AIRDROP,
  CLIPBOARD,
  SCREEN,
  OPEN_SOURCE,
  PRIVATE,
  COMPARE,
  GUIDES_HUB,
];
