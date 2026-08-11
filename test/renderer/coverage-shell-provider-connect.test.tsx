import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  LlmProviderConnectModal,
  type LlmProviderConnectKey,
} from '@renderer/components/LlmProviderConnectModal';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';

const t = en as unknown as AppDictionary;

interface RenderConnectModalOptions {
  authenticated?: boolean;
  busy?: boolean;
  installed?: boolean;
  open?: boolean;
  provider?: LlmProviderConnectKey;
}

const renderConnectModal = ({
  authenticated = false,
  busy = false,
  installed,
  open = true,
  provider = 'codex',
}: RenderConnectModalOptions = {}) => {
  const onClose = vi.fn();
  const onConnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const onOpenExternalUrl = vi.fn();
  const view = render(
    <LlmProviderConnectModal
      open={open}
      provider={provider}
      providerName="ChatGPT / Codex"
      providerOwner="OpenAI"
      authenticated={authenticated}
      busy={busy}
      {...(installed === undefined ? {} : { installed })}
      title="Connect a local agent"
      body="Your credentials stay local."
      steps={['Open the terminal', 'Finish sign in']}
      termsUrl="https://example.test/terms"
      privacyUrl="https://example.test/privacy"
      connectLabel="Connect account"
      t={t}
      onClose={onClose}
      onConnect={onConnect}
      onOpenExternalUrl={onOpenExternalUrl}
    />,
  );
  return { ...view, onClose, onConnect, onOpenExternalUrl };
};

describe('LlmProviderConnectModal shell', () => {
  it('requires informed consent, opens policy links safely, and starts connection', async () => {
    const user = userEvent.setup();
    const handlers = renderConnectModal({ installed: false });

    expect(screen.getByRole('dialog', { name: 'Connect ChatGPT / Codex' }).closest('[data-provider]')).toHaveAttribute('data-provider', 'codex');
    expect(screen.getByText(t.llmProviderConnect.notInstalled)).toBeInTheDocument();
    expect(screen.getByText('Open the terminal')).toBeInTheDocument();
    expect(screen.getByText('Finish sign in')).toBeInTheDocument();

    const connect = screen.getByRole('button', { name: 'Connect account' });
    expect(connect).toBeDisabled();

    await user.click(screen.getByRole('link', { name: t.llmProviderConnect.termsLink }));
    await user.click(screen.getByRole('link', { name: t.llmProviderConnect.privacyLink }));
    expect(handlers.onOpenExternalUrl.mock.calls).toEqual([
      ['https://example.test/terms'],
      ['https://example.test/privacy'],
    ]);

    await user.click(screen.getByRole('checkbox', { name: t.llmProviderConnect.checkbox('ChatGPT / Codex') }));
    expect(connect).toBeEnabled();
    await user.click(connect);
    expect(handlers.onConnect).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: t.actions.close }));
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it('shows the installed busy state and locks dismissal and connection', async () => {
    const user = userEvent.setup();
    const handlers = renderConnectModal({ busy: true });

    expect(screen.getByText(t.llmProviderConnect.notConnected)).toBeInTheDocument();
    expect(screen.getAllByText(t.llmProviderConnect.connecting('ChatGPT / Codex'))).toHaveLength(2);
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(screen.getByRole('button', { name: t.actions.close })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect account' })).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(handlers.onClose).not.toHaveBeenCalled();
    expect(handlers.onConnect).not.toHaveBeenCalled();
  });

  it('hides the connect action for an authenticated provider', () => {
    renderConnectModal({ authenticated: true });

    expect(screen.getByText(t.llmProviderConnect.connected)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect account' })).not.toBeInTheDocument();
  });

  it('clears prior consent when the modal closes before another provider opens', async () => {
    const user = userEvent.setup();
    const handlers = renderConnectModal();
    const checkbox = screen.getByRole('checkbox', { name: t.llmProviderConnect.checkbox('ChatGPT / Codex') });
    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    handlers.rerender(
      <LlmProviderConnectModal
        open={false}
        provider="claude"
        providerName="Claude Code"
        providerOwner="Anthropic"
        authenticated={false}
        busy={false}
        title="Connect Claude"
        body="Use a local Claude session."
        steps={[]}
        termsUrl="https://example.test/claude-terms"
        privacyUrl="https://example.test/claude-privacy"
        connectLabel="Connect Claude"
        t={t}
        onClose={handlers.onClose}
        onConnect={handlers.onConnect}
        onOpenExternalUrl={handlers.onOpenExternalUrl}
      />,
    );
    handlers.rerender(
      <LlmProviderConnectModal
        open
        provider="claude"
        providerName="Claude Code"
        providerOwner="Anthropic"
        authenticated={false}
        busy={false}
        title="Connect Claude"
        body="Use a local Claude session."
        steps={[]}
        termsUrl="https://example.test/claude-terms"
        privacyUrl="https://example.test/claude-privacy"
        connectLabel="Connect Claude"
        t={t}
        onClose={handlers.onClose}
        onConnect={handlers.onConnect}
        onOpenExternalUrl={handlers.onOpenExternalUrl}
      />,
    );

    expect(screen.getByRole('checkbox', { name: t.llmProviderConnect.checkbox('Claude Code') })).not.toBeChecked();
  });
});
