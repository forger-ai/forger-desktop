import http from 'node:http';

export interface RemoteTunnel {
  url: string;
  close: () => Promise<void>;
}

export interface RemoteTunnelProvider {
  open: (input: { port: number; appId: string; sessionId: string }) => Promise<RemoteTunnel>;
}

export class LocalTunnelProvider implements RemoteTunnelProvider {
  async open(input: { port: number; appId: string; sessionId: string }): Promise<RemoteTunnel> {
    const configuredUrl = process.env.FORGER_REMOTE_TUNNEL_PUBLIC_URL;
    if (configuredUrl) {
      return { url: configuredUrl.replace(/\/+$/, ''), close: async () => undefined };
    }
    const localtunnel = await (Function('return import("localtunnel")')() as Promise<{ default: (input: unknown) => Promise<{ url: string; close: () => void }> }>).catch(() => null);
    if (!localtunnel) {
      throw new Error('localtunnel_dependency_missing');
    }
    const tunnel = await withTimeout(
      localtunnel.default({
        port: input.port,
        local_host: '127.0.0.1',
        subdomain: remoteTunnelSubdomain(input.appId, input.sessionId),
      }),
      20_000,
      'localtunnel_open_timeout',
    );
    return {
      url: tunnel.url.replace(/\/+$/, ''),
      close: async () => {
        tunnel.close();
      },
    };
  }
}

export const remoteTunnelSubdomain = (appId: string, sessionId: string): string => {
  const normalizedAppId = appId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const normalizedSessionId = sessionId.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `forger-${normalizedAppId}-${normalizedSessionId}`.slice(0, 50).replace(/-$/g, '');
};

export const listenLocal = async (server: http.Server): Promise<number> =>
  await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
        return;
      }
      reject(new Error('remote_tunnel_port_unavailable'));
    });
  });

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};
