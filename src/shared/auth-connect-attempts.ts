export type IntelligenceProviderAuth = 'codex' | 'claude';

export interface AuthConnectAttempt {
  provider: IntelligenceProviderAuth;
  id: number;
  canceled: boolean;
}

export class AuthConnectAttemptTracker {
  private currentAttempt: AuthConnectAttempt | null = null;
  private nextId = 0;

  begin(provider: IntelligenceProviderAuth): AuthConnectAttempt {
    const attempt = { provider, id: this.nextId + 1, canceled: false };
    this.nextId = attempt.id;
    this.currentAttempt = attempt;
    return attempt;
  }

  isActive(attempt: AuthConnectAttempt): boolean {
    return this.currentAttempt === attempt && !attempt.canceled;
  }

  finish(attempt: AuthConnectAttempt): IntelligenceProviderAuth | null {
    if (this.currentAttempt !== attempt) {
      return null;
    }
    this.currentAttempt = null;
    return attempt.provider;
  }

  cancel(provider: IntelligenceProviderAuth): AuthConnectAttempt | null {
    if (!this.currentAttempt || this.currentAttempt.provider !== provider) {
      return null;
    }
    const attempt = this.currentAttempt;
    attempt.canceled = true;
    this.currentAttempt = null;
    return attempt;
  }

  get busyProvider(): IntelligenceProviderAuth | null {
    return this.currentAttempt?.provider ?? null;
  }
}
