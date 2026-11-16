import { describe, expect, it } from 'vitest';
import { SignalingHub } from '../../../src/server/signalingHub.js';
import { WarpClient } from '../../../src/client/engine/warpClient.js';

function waitFor(fn: () => boolean, label: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (fn()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > timeout) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for condition: ${label}`));
      }
    }, 20);
  });
}

describe('F20: Strict Pair Code Synchronization, QR Link Parsing & Room Rotation', () => {
  it('synchronizes host desktop clients to the exact same host pair code', async () => {
    const hub = new SignalingHub({
      getLanUrls: () => ['http://192.168.1.150:3000'],
      getDaemonStatus: () => ({ enabled: true, platform: 'macos', hostname: 'MacBook', autoSaveToDownloads: true }),
    });

    const server = hub.wss;
    const serverPort = 3999;
    const http = (await import('node:http')).createServer();
    http.on('upgrade', (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        server.emit('connection', ws, req);
      });
    });
    await new Promise<void>((r) => http.listen(serverPort, '127.0.0.1', r));
    const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;

    const macApp = new WarpClient({
      wsUrl,
      deviceOverride: { name: 'MacBook Pro M3', platform: 'macos', model: 'MacBook', formFactor: 'laptop' },
    });
    const backgroundPeer = new WarpClient({
      wsUrl,
      deviceOverride: { name: 'AirBridge Background', platform: 'macos', model: 'AirBridge service', formFactor: 'laptop' },
    });

    try {
      await macApp.start();
      await backgroundPeer.start();

      await waitFor(() => macApp.getSnapshot().pairCode.length === 6, 'macApp pair code length');
      await waitFor(() => backgroundPeer.getSnapshot().pairCode.length === 6, 'backgroundPeer pair code length');

      // Both local desktop clients MUST share the host pair code
      expect(macApp.getSnapshot().pairCode).toBe(backgroundPeer.getSnapshot().pairCode);

      // Phone joins via QR code containing the Mac's pair code
      const macPairCode = macApp.getSnapshot().pairCode;
      const phone = new WarpClient({
        wsUrl,
        initialPairCode: macPairCode,
        deviceOverride: { name: 'Galaxy S25 Ultra', platform: 'android', model: 'Galaxy', formFactor: 'phone' },
      });

      await phone.start();
      await waitFor(() => phone.getSnapshot().pairCode === macPairCode, 'phone pair code matches macPairCode');
      await waitFor(() => macApp.getSnapshot().peers.some((p) => p.device.name === 'Galaxy S25 Ultra'), 'macApp sees phone');
      await waitFor(() => phone.getSnapshot().peers.some((p) => p.device.name === 'MacBook Pro M3'), 'phone sees macApp');

      // Rotating pair code on Mac updates host pair code and background peer
      macApp.rotatePairCode();

      await waitFor(() => macApp.getSnapshot().pairCode !== macPairCode, 'macApp pair code changes after rotate');
      const rotatedCode = macApp.getSnapshot().pairCode;

      await waitFor(() => backgroundPeer.getSnapshot().pairCode === rotatedCode, 'backgroundPeer gets rotated code');

      // Phone joins the new rotated pair code
      phone.joinPairCode(rotatedCode);
      await waitFor(() => phone.getSnapshot().pairCode === rotatedCode, 'phone gets rotated code after join');
      await waitFor(() => macApp.getSnapshot().peers.some((p) => p.device.name === 'Galaxy S25 Ultra'), 'macApp sees phone after re-join');

      phone.stop();
    } finally {
      macApp.stop();
      backgroundPeer.stop();
      hub.close();
      http.close();
    }
  });

  it('assigns a unique default pair code to every remote device and enforces strict room isolation', async () => {
    const hub = new SignalingHub({
      getLanUrls: () => ['http://192.168.1.150:3000'],
      getDaemonStatus: () => ({ enabled: true, platform: 'macos', hostname: 'MacBook', autoSaveToDownloads: true }),
    });

    const server = hub.wss;
    const serverPort = 3997;
    const http = (await import('node:http')).createServer();
    http.on('upgrade', (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        server.emit('connection', ws, req);
      });
    });
    await new Promise<void>((r) => http.listen(serverPort, '127.0.0.1', r));
    const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;

    const phone1 = new WarpClient({
      wsUrl,
      deviceOverride: { name: 'Phone 1', platform: 'android', model: 'Galaxy', formFactor: 'phone' },
    });
    const phone2 = new WarpClient({
      wsUrl,
      deviceOverride: { name: 'Phone 2', platform: 'android', model: 'Pixel', formFactor: 'phone' },
    });

    try {
      await phone1.start();
      await phone2.start();

      await waitFor(() => phone1.getSnapshot().pairCode.length === 6, 'phone1 pair code length');
      await waitFor(() => phone2.getSnapshot().pairCode.length === 6, 'phone2 pair code length');

      // Every remote device MUST start with a unique pair code, distinct from
      // the host QR room. The server must guard against even random collisions.
      expect(phone1.getSnapshot().pairCode).not.toBe(phone2.getSnapshot().pairCode);
      expect(phone1.getSnapshot().pairCode).not.toBe(hub.getDefaultPairCode());
      expect(phone2.getSnapshot().pairCode).not.toBe(hub.getDefaultPairCode());

      phone1.setVisibility('paired-only');
      phone2.setVisibility('paired-only');

      // Unpaired devices MUST NOT see each other in paired-only mode
      await new Promise((r) => setTimeout(r, 200));
      expect(phone1.getSnapshot().peers.length).toBe(0);
      expect(phone2.getSnapshot().peers.length).toBe(0);
    } finally {
      phone1.stop();
      phone2.stop();
      hub.close();
      http.close();
    }
  });

  it('delivers notification beams when enabled and ignores them when notificationSharing is false', async () => {
    const hub = new SignalingHub({
      getLanUrls: () => ['http://192.168.1.150:3000'],
      getDaemonStatus: () => ({ enabled: true, platform: 'macos', hostname: 'MacBook', autoSaveToDownloads: true }),
    });

    const server = hub.wss;
    const serverPort = 3998;
    const http = (await import('node:http')).createServer();
    http.on('upgrade', (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        server.emit('connection', ws, req);
      });
    });
    await new Promise<void>((r) => http.listen(serverPort, '127.0.0.1', r));
    const wsUrl = `ws://127.0.0.1:${serverPort}/ws`;

    const receivedNotifs: Array<{ title: string; body: string; appName?: string }> = [];

    const mac = new WarpClient({
      wsUrl,
      initialPairCode: 'TEST99',
      deviceOverride: { name: 'MacBook Air', platform: 'macos', model: 'MacBook', formFactor: 'laptop' },
      onIncomingNotification: (notif) => {
        receivedNotifs.push(notif);
      },
    });

    const phone = new WarpClient({
      wsUrl,
      initialPairCode: 'TEST99',
      deviceOverride: { name: 'Galaxy Phone', platform: 'android', model: 'Galaxy', formFactor: 'phone' },
    });

    try {
      await mac.start();
      await phone.start();

      await waitFor(() => mac.getSnapshot().peers.length === 1, 'mac sees phone peer');
      await waitFor(() => phone.getSnapshot().peers.length === 1, 'phone sees mac peer');

      const macPeerId = mac.getSnapshot().peerId;

      // 1. Send notification while enabled -> MUST be received by Mac
      await phone.sendNotification(macPeerId, 'New Message', 'Hello from WhatsApp!', 'WhatsApp');
      await waitFor(() => receivedNotifs.length === 1, 'received notification count === 1');
      expect(receivedNotifs[0].title).toBe('New Message');
      expect(receivedNotifs[0].body).toBe('Hello from WhatsApp!');
      expect(receivedNotifs[0].appName).toBe('WhatsApp');

      // 2. Disable notification sharing on Mac -> MUST NOT receive subsequent notifications
      mac.setNotificationSharing(false);
      expect(mac.getSnapshot().notificationSharing).toBe(false);

      await phone.sendNotification(macPeerId, 'Blocked Message', 'Should not arrive', 'Slack');
      await new Promise((r) => setTimeout(r, 200));
      expect(receivedNotifs.length).toBe(1);

      // 3. Re-enable notification sharing on Mac -> MUST receive again
      mac.setNotificationSharing(true);
      expect(mac.getSnapshot().notificationSharing).toBe(true);

      await phone.sendNotification(macPeerId, 'Active Message', 'Arrived cleanly!', 'Telegram');
      await waitFor(() => receivedNotifs.length === 2, 'received notification count === 2');
      expect(receivedNotifs[1].title).toBe('Active Message');
      expect(receivedNotifs[1].appName).toBe('Telegram');
    } finally {
      mac.stop();
      phone.stop();
      hub.close();
      http.close();
    }
  });
});
