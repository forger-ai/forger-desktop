import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { sendOAuthCallbackPage } from './page';
import { readCallbackPort, writeCallbackPort } from './store';
import type { OAuthCallbackFlow, OAuthCallbackServerState, SelfOAuthCallbackServiceLike } from './types';

interface SelfOAuthCallbackServiceOptions {
  metadataRoot: string;
  appendLog?: (event: string, payload?: Record<string, unknown>) => Promise<void>;
}

export class SelfOAuthCallbackService implements SelfOAuthCallbackServiceLike {
  private server: Server | null = null;
  private state: OAuthCallbackServerState | null = null;
  private readonly flows = new Map<string, OAuthCallbackFlow>();

  constructor(private readonly options: SelfOAuthCallbackServiceOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    const stored = await readCallbackPort(this.options.metadataRoot);
    const preferred = Number(process.env.FORGER_OAUTH_CALLBACK_PORT) || stored.port || 0;
    const first = await this.listen(preferred).catch(async () => {
      if (!preferred) throw new Error('oauth_callback_port_unavailable');
      return await this.listen(0);
    });
    const rotated = Boolean(preferred && first.port !== preferred);
    this.server = first.server;
    this.state = {
      baseUrl: `http://127.0.0.1:${first.port}`,
      port: first.port,
      ...(rotated ? { previousPort: preferred, rotatedAt: new Date().toISOString() } : stored),
      portChanged: rotated || Boolean(stored.previousPort && stored.previousPort !== first.port),
    };
    await writeCallbackPort(this.options.metadataRoot, {
      port: first.port,
      ...(this.state.previousPort ? { previousPort: this.state.previousPort } : {}),
      ...(this.state.rotatedAt ? { rotatedAt: this.state.rotatedAt } : {}),
    });
    await this.options.appendLog?.('self_oauth_callback:started', { ...this.state });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.flows.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getState(): OAuthCallbackServerState | null {
    return this.state;
  }

  callbackUrl(callbackPath: string): string {
    return this.state ? `${this.state.baseUrl}${callbackPath}` : '';
  }

  registerFlow(flow: OAuthCallbackFlow): () => void {
    this.flows.set(flow.callbackPath, flow);
    return () => {
      if (this.flows.get(flow.callbackPath) === flow) this.flows.delete(flow.callbackPath);
    };
  }

  private async listen(port: number): Promise<{ server: Server; port: number }> {
    const server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error) => {
        server.close(() => undefined);
        reject(error);
      });
      server.listen(port, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo | null;
    if (!address?.port) throw new Error('oauth_callback_address_unavailable');
    return { server, port: address.port };
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const baseUrl = this.state?.baseUrl ?? 'http://127.0.0.1';
    const requestUrl = new URL(request.url ?? '/', baseUrl);
    const flow = this.flows.get(requestUrl.pathname);
    if (!flow) return sendOAuthCallbackPage(response, 404, 'idle', 'Forger', 'No active connection request is waiting for this callback.');
    if (Date.now() > flow.expiresAt) {
      this.flows.delete(flow.callbackPath);
      return sendOAuthCallbackPage(response, 408, 'error', 'Connection expired', 'Return to Forger and start the connection again.');
    }
    try {
      await flow.handle(requestUrl, response);
    } catch (error) {
      if (!response.headersSent) {
        const body = error instanceof Error ? error.message : 'OAuth failed.';
        sendOAuthCallbackPage(response, 500, 'error', 'Could not connect', body);
      }
    }
  }
}
