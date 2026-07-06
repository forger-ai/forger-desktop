import http from 'node:http';
import type { Server } from 'node:http';
import type { OAuthCallbackFlow } from '../../oauth-callback/types';

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

export const runEphemeralCallbackServer = async (
  flow: OAuthCallbackFlow,
): Promise<{ redirectUri: string; close: () => Promise<void> }> => {
  let server: Server | null = null;
  const port = await new Promise<number>((resolve, reject) => {
    server = http.createServer((request, response) => {
      const address = server?.address();
      const host = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : 'http://127.0.0.1';
      void flow.handle(new URL(request.url ?? '/', host), response);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server?.address();
      if (!address || typeof address !== 'object') reject(new Error('oauth_callback_port_unavailable'));
      else resolve(address.port);
    });
  });
  return {
    redirectUri: `http://127.0.0.1:${port}${flow.callbackPath}`,
    close: async () => {
      if (server) await closeServer(server).catch(() => undefined);
    },
  };
};
