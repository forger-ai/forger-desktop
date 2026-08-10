import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SetupGuideDialog } from '@renderer/views/connections/SetupGuideDialog';
import { getSetupGuideUiCopy } from '@renderer/views/connections/setupGuideUiCopy';
import type { ConnectionSetupGuide } from '@shared/types';

const fullGuide: ConnectionSetupGuide = {
  title: 'Connect Example Mail',
  summary: 'Configure the provider before returning to Forger.',
  portal: { label: 'Example developer portal', url: 'https://example.test/developer' },
  copyValues: [
    { kind: 'callback_url', label: 'Callback URL', value: 'http://127.0.0.1/callback' },
    { kind: 'scope', label: 'Required scope', value: 'mail.read' },
  ],
  steps: ['Create an application', 'Paste the callback URL'],
  notes: ['Keep the client secret private.'],
  commonErrors: ['The callback URL must match exactly.'],
};

describe('SetupGuideDialog shell', () => {
  it('renders nothing without a selected guide', () => {
    const { container } = render(
      <SetupGuideDialog
        guide={null}
        open
        onClose={vi.fn()}
        onCopy={vi.fn()}
        onOpenExternalUrl={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(getSetupGuideUiCopy()).toMatchObject({ close: 'Close', steps: 'Steps' });
  });

  it('exposes the provider portal, copy values, safety notes, and common errors', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onCopy = vi.fn();
    const onOpenExternalUrl = vi.fn();
    render(
      <SetupGuideDialog
        guide={fullGuide}
        locale="en-US"
        open
        onClose={onClose}
        onCopy={onCopy}
        onOpenExternalUrl={onOpenExternalUrl}
      />,
    );

    expect(screen.getByRole('dialog', { name: fullGuide.title })).toBeInTheDocument();
    expect(screen.getByText(fullGuide.summary)).toBeInTheDocument();
    expect(screen.getByText('Security notes')).toBeInTheDocument();
    expect(screen.getByText('Common errors')).toBeInTheDocument();
    expect(screen.getByText(fullGuide.notes![0])).toBeInTheDocument();
    expect(screen.getByText(fullGuide.commonErrors![0])).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Open provider/ }));
    expect(onOpenExternalUrl).toHaveBeenCalledWith('https://example.test/developer');

    const copyButtons = screen.getAllByRole('button', { name: 'Copy' });
    await user.click(copyButtons[0]);
    await user.click(copyButtons[1]);
    expect(onCopy.mock.calls).toEqual([
      ['http://127.0.0.1/callback'],
      ['mail.read'],
    ]);

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('supports a minimal Spanish guide without optional sections', () => {
    const guide: ConnectionSetupGuide = {
      title: 'Configurar chat',
      summary: 'Sigue el único paso.',
      steps: ['Autoriza la conexión'],
      copyValues: [],
      notes: [],
      commonErrors: [],
    };
    render(
      <SetupGuideDialog
        guide={guide}
        locale="ES-cl"
        open
        onClose={vi.fn()}
        onCopy={vi.fn()}
        onOpenExternalUrl={vi.fn()}
      />,
    );

    expect(screen.getByText('Pasos')).toBeInTheDocument();
    expect(screen.queryByText('Abrir portal')).not.toBeInTheDocument();
    expect(screen.queryByText('Valores para copiar')).not.toBeInTheDocument();
    expect(screen.queryByText('Notas de seguridad')).not.toBeInTheDocument();
    expect(screen.queryByText('Errores comunes')).not.toBeInTheDocument();
  });

  it('contains a provider portal disappearing between render and click', async () => {
    const user = userEvent.setup();
    const onOpenExternalUrl = vi.fn();
    let portalReads = 0;
    const guide = {
      title: 'Transient guide',
      summary: 'The provider configuration changed.',
      steps: [],
      get portal() {
        portalReads += 1;
        return portalReads <= 2
          ? { label: 'Temporary portal', url: 'https://example.test/temporary' }
          : undefined;
      },
    } satisfies ConnectionSetupGuide;
    render(
      <SetupGuideDialog
        guide={guide}
        open
        onClose={vi.fn()}
        onCopy={vi.fn()}
        onOpenExternalUrl={onOpenExternalUrl}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Temporary portal/ }));
    expect(onOpenExternalUrl).toHaveBeenCalledWith('');
  });
});
