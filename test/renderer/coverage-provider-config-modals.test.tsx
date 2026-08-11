import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ClaudeAuthStatus, CodexAuthStatus, CodexRateLimitBucket } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import { ClaudeConfigModal } from '@renderer/components/ClaudeConfigModal';
import { CodexConfigModal } from '@renderer/components/CodexConfigModal';

const t = getDictionary('en');

const codexStatus = (overrides: Partial<CodexAuthStatus> = {}): CodexAuthStatus => ({
  installed: true,
  authenticated: true,
  authFilePath: '/profile/auth.json',
  codexHome: '/profile/codex',
  codexCliPath: '/usr/bin/codex',
  ...overrides,
});

const claudeStatus = (overrides: Partial<ClaudeAuthStatus> = {}): ClaudeAuthStatus => ({
  installed: true,
  authenticated: true,
  source: 'managed',
  version: '2.4.0 (Claude Code)',
  ...overrides,
});

const handlers = () => ({
  onClose: vi.fn(),
  onConnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  onRefresh: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  onDisconnect: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  onSignOut: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  onReinstall: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  onOpenExternalUrl: vi.fn(),
});

const renderCodex = (status: CodexAuthStatus, busy = false) => {
  const callbacks = handlers();
  render(
    <CodexConfigModal
      open
      status={status}
      busy={busy}
      t={t}
      onClose={callbacks.onClose}
      onConnect={callbacks.onConnect}
      onRefresh={callbacks.onRefresh}
      onOpenExternalUrl={callbacks.onOpenExternalUrl}
    />,
  );
  return callbacks;
};

const renderClaude = (status: ClaudeAuthStatus, forgerConnected = true, busy = false) => {
  const callbacks = handlers();
  render(
    <ClaudeConfigModal
      open
      status={status}
      forgerConnected={forgerConnected}
      busy={busy}
      t={t}
      onClose={callbacks.onClose}
      onConnect={callbacks.onConnect}
      onRefresh={callbacks.onRefresh}
      onDisconnect={callbacks.onDisconnect}
      onSignOut={callbacks.onSignOut}
      onReinstall={callbacks.onReinstall}
      onOpenExternalUrl={callbacks.onOpenExternalUrl}
    />,
  );
  return callbacks;
};

const rateBucket = (overrides: Partial<CodexRateLimitBucket> = {}): CodexRateLimitBucket => ({
  limitId: 'five-hour',
  limitName: 'Interactive work',
  primary: {
    usedPercent: 42.4,
    remainingPercent: 57.6,
    windowDurationMins: 300,
    resetsAt: 1_786_320_000,
  },
  ...overrides,
});

describe('CodexConfigModal', () => {
  it('delegates disconnected setup to the informed connection flow', () => {
    renderCodex(codexStatus({ authenticated: false }));
    expect(screen.getByRole('dialog', { name: t.llmProviderConnect.title(t.llmProviderConnect.providers.codex.name) })).toBeVisible();
    expect(screen.getByText(t.llmProviderConnect.providers.codex.body)).toBeVisible();
  });

  it('shows an authenticated account, technical paths, and refreshes or closes', async () => {
    const user = userEvent.setup();
    const callbacks = renderCodex(codexStatus());

    expect(screen.getByText(t.settings.codexConnected)).toBeVisible();
    expect(screen.getByText(t.codexSetup.ready)).toBeVisible();
    await user.click(screen.getByText(t.settings.technicalDetails));
    expect(screen.getByText(new RegExp('/usr/bin/codex'))).toBeVisible();
    expect(screen.getByText(new RegExp('/profile/codex'))).toBeVisible();
    expect(screen.getByText(new RegExp('/profile/auth.json'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: t.settings.codexRefreshAction }));
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('shows primary usage, reset time, remaining quota, and a reached warning', () => {
    const bucket = rateBucket({ rateLimitReachedType: 'primary' });
    renderCodex(codexStatus({
      rateLimits: { primary: bucket, buckets: [rateBucket({ limitId: 'fallback' })], checkedAt: '2026-08-10T12:00:00Z' },
    }));

    expect(screen.getByText(t.settings.codexUsageLimitReached)).toBeVisible();
    expect(screen.getByText(t.settings.codexUsageUsed(42))).toBeVisible();
    expect(screen.getByText(t.settings.codexUsageRemaining(58))).toBeVisible();
    expect(screen.getByText(t.settings.codexUsageWindow(300))).toBeVisible();
    expect(screen.getByText(t.settings.codexUsageBucket('Interactive work'))).toBeVisible();
  });

  it('falls back to the first bucket, derived quota, ID, and missing technical values', () => {
    const bucket = rateBucket({
      limitId: 'fallback-id',
      limitName: null,
      primary: { usedPercent: 95 },
      rateLimitReachedType: null,
    });
    renderCodex(codexStatus({
      codexCliPath: undefined,
      codexHome: '',
      authFilePath: '',
      rateLimits: { buckets: [bucket], checkedAt: '2026-08-10T12:00:00Z' },
    }));
    expect(screen.getByText(t.settings.codexUsageUsed(95))).toBeVisible();
    expect(screen.getByText(t.settings.codexUsageRemaining(5))).toBeVisible();
    expect(screen.getByText(t.settings.codexUsageBucket('fallback-id'))).toBeVisible();
    expect(screen.queryByText(t.settings.codexUsageLimitReached)).not.toBeInTheDocument();
    expect(screen.getAllByText(/: -$/)).toHaveLength(3);
  });

  it('renders an informational empty usage window and locks refresh while busy', () => {
    renderCodex(codexStatus({
      rateLimits: { buckets: [rateBucket({ primary: undefined })], checkedAt: '2026-08-10T12:00:00Z' },
    }), true);
    expect(screen.getByText(t.settings.codexUsageUsed(0))).toBeVisible();
    expect(screen.getByText(t.settings.codexUsageRemaining(100))).toBeVisible();
    expect(screen.getByRole('button', { name: t.settings.codexRefreshAction })).toBeDisabled();
  });
});

describe('ClaudeConfigModal', () => {
  it('delegates a disconnected account to setup', () => {
    renderClaude(claudeStatus({ authenticated: false, source: 'missing', installed: false }), false);
    expect(screen.getByRole('dialog', { name: t.llmProviderConnect.title(t.llmProviderConnect.providers.claude.name) })).toBeVisible();
    expect(screen.getByText(t.llmProviderConnect.providers.claude.body)).toBeVisible();
  });

  it('shows a ready managed install and runs every confirmed account action', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const callbacks = renderClaude(claudeStatus());

    expect(screen.getByText(t.settings.claudeSourceManaged)).toBeVisible();
    expect(screen.getByText(t.settings.claudeReady)).toBeVisible();
    expect(screen.getByText(t.settings.claudeConnectionActive)).toBeVisible();
    expect(screen.getByText(t.settings.claudeDetectedVersion('2.4.0'))).toBeVisible();

    await user.click(screen.getByRole('button', { name: t.settings.claudeDisconnectForgerAction }));
    await user.click(screen.getByRole('button', { name: t.settings.claudeSignOutAction }));
    await user.click(screen.getByRole('button', { name: t.agentProvider.refresh }));
    await user.click(screen.getByRole('button', { name: t.settings.claudeReinstallAction }));
    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(confirm).toHaveBeenCalledWith(t.settings.claudeSignOutConfirm);
    expect(callbacks.onDisconnect).toHaveBeenCalledOnce();
    expect(callbacks.onSignOut).toHaveBeenCalledOnce();
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
    expect(callbacks.onReinstall).toHaveBeenCalledOnce();
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('shows a busy system install with a missing session and disables mutations', () => {
    renderClaude(claudeStatus({ authenticated: false, source: 'system', version: undefined }), true, true);
    expect(screen.getByText(t.settings.claudeSourceSystem)).toBeVisible();
    expect(screen.getByText(t.agentProvider.claudeConnecting)).toBeVisible();
    expect(screen.getByText(t.settings.claudeConnectionMissingSession)).toBeVisible();
    expect(screen.getByText(t.settings.claudeDetectedVersion(t.settings.claudeVersionMissing))).toBeVisible();
    for (const button of screen.getAllByRole('button')) {
      if (button.textContent !== t.actions.close) expect(button).toBeDisabled();
    }
  });

  it('shows an available missing install and respects sign-out cancellation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const callbacks = renderClaude(claudeStatus({ authenticated: false, installed: false, source: 'missing', version: '' }));
    expect(screen.getByText(t.settings.claudeSourceMissing)).toBeVisible();
    expect(screen.getByText(t.settings.claudeConnectionInstallAvailable)).toBeVisible();
    await user.click(screen.getByRole('button', { name: t.settings.claudeSignOutAction }));
    expect(callbacks.onSignOut).not.toHaveBeenCalled();
  });
});
