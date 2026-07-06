import type http from 'node:http';

export interface OAuthCallbackFlow {
  type: string;
  callbackPath: string;
  expiresAt: number;
  handle(requestUrl: URL, response: http.ServerResponse): Promise<void>;
}

export interface OAuthCallbackServerState {
  baseUrl: string;
  port: number;
  previousPort?: number;
  rotatedAt?: string;
  portChanged: boolean;
}

export interface SelfOAuthCallbackServiceLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): OAuthCallbackServerState | null;
  callbackUrl(callbackPath: string): string;
  registerFlow(flow: OAuthCallbackFlow): () => void;
}
