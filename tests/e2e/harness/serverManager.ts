import {
  createAirBridgeServer,
  type AirBridgeServerInstance,
  type AirBridgeServerOptions,
} from '../../../src/server/index.js';

export interface TestServerInstance {
  port: number;
  wsUrl: string;
  httpUrl: string;
  server: AirBridgeServerInstance;
  close: () => Promise<void>;
}

// Global registry of active test servers for guaranteed cleanup in teardown
const activeServers = new Set<TestServerInstance>();

/**
 * Creates an ephemeral AirBridge server on an OS-assigned port (port: 0)
 * bound strictly to 127.0.0.1 with mDNS and background clipboard disabled.
 */
export async function createTestServer(
  options: Partial<AirBridgeServerOptions> = {}
): Promise<TestServerInstance> {
  const mergedOptions: AirBridgeServerOptions = {
    port: 0,
    host: '127.0.0.1',
    mode: 'test',
    enableMdns: false,
    https: false,
    hostClipboard: false,
    receivedFolderSettingsPath: null,
    ...options,
  };

  const server = await createAirBridgeServer(mergedOptions);
  const port = server.port;
  const protocol = server.protocol ?? (mergedOptions.https ? 'https' : 'http');
  const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

  let isClosed = false;

  const instance: TestServerInstance = {
    port,
    wsUrl: `${wsProtocol}://127.0.0.1:${port}/ws`,
    httpUrl: `${protocol}://127.0.0.1:${port}`,
    server,
    close: async () => {
      if (isClosed) return;
      isClosed = true;
      activeServers.delete(instance);
      try {
        await server.close();
      } catch {
        // Suppress errors during shutdown if already partially destroyed
      }
    },
  };

  activeServers.add(instance);
  return instance;
}

export type ServerHandle = TestServerInstance;
export type ServerOptions = Partial<AirBridgeServerOptions>;

/** Alias of [createTestServer] for ergonomics across E2E helpers and suites. */
export const startTestServer = createTestServer;

/**
 * Cleanly closes all active test servers currently registered.
 */
export async function closeAllTestServers(): Promise<void> {
  const serversToClose = Array.from(activeServers);
  activeServers.clear();
  await Promise.all(
    serversToClose.map(async (srv) => {
      try {
        await srv.close();
      } catch {
        // Ignore errors during batch shutdown
      }
    })
  );
}
