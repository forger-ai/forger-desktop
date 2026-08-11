import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalMarkdownLink } from '@renderer/components/ExternalMarkdownLink';

const openExternalUrl = vi.fn<(url: string) => Promise<void>>();

beforeEach(() => {
  openExternalUrl.mockReset();
  openExternalUrl.mockResolvedValue(undefined);
  Object.defineProperty(window, 'forger', {
    configurable: true,
    value: { openExternalUrl },
  });
});

describe('ExternalMarkdownLink', () => {
  it.each([
    'https://forger.ai/docs',
    'http://127.0.0.1:5173/help',
    'file:///Users/person/Forger/readme.md',
    '/Users/person/Forger/readme.md',
    '~/Forger/readme.md',
    'C:\\Users\\person\\Forger\\readme.md',
    '\\\\server\\Forger\\readme.md',
  ])('opens the safe destination through the preload boundary: %s', async (href) => {
    const user = userEvent.setup();
    render(<ExternalMarkdownLink href={href}>Open help</ExternalMarkdownLink>);

    const link = screen.getByRole('link', { name: 'Open help' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');

    await user.click(link);

    expect(openExternalUrl).toHaveBeenCalledOnce();
    expect(openExternalUrl).toHaveBeenCalledWith(href);
  });

  it.each(['javascript:alert(1)', 'data:text/html,unsafe', 'mailto:person@example.com', 'relative/file.md']) (
    'prevents browser navigation and refuses an unsafe destination: %s',
    (href) => {
      const onOpenExternalUrl = vi.fn();
      render(
        <ExternalMarkdownLink href={href} onOpenExternalUrl={onOpenExternalUrl}>
          Unsafe link
        </ExternalMarkdownLink>,
      );

      const link = screen.getByRole('link', { name: 'Unsafe link' });
      expect(fireEvent.click(link)).toBe(false);
      expect(onOpenExternalUrl).not.toHaveBeenCalled();
      expect(openExternalUrl).not.toHaveBeenCalled();
    },
  );

  it('honors a consumer preventDefault before opening anything', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn((event: React.MouseEvent<HTMLAnchorElement>) => event.preventDefault());
    const onOpenExternalUrl = vi.fn();
    render(
      <ExternalMarkdownLink
        href="https://forger.ai"
        onClick={onClick}
        onOpenExternalUrl={onOpenExternalUrl}
      >
        Managed link
      </ExternalMarkdownLink>,
    );

    await user.click(screen.getByRole('link', { name: 'Managed link' }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(onOpenExternalUrl).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('uses an injected opener and preserves explicitly supplied anchor policy', async () => {
    const user = userEvent.setup();
    const onOpenExternalUrl = vi.fn();
    render(
      <ExternalMarkdownLink
        href="https://forger.ai"
        rel="noopener"
        target="docs-window"
        onOpenExternalUrl={onOpenExternalUrl}
      >
        Product docs
      </ExternalMarkdownLink>,
    );

    const link = screen.getByRole('link', { name: 'Product docs' });
    await user.click(link);

    expect(onOpenExternalUrl).toHaveBeenCalledWith('https://forger.ai');
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(link).toHaveAttribute('rel', 'noopener');
    expect(link).toHaveAttribute('target', 'docs-window');
  });

  it('does not intercept a link without a destination', () => {
    render(<ExternalMarkdownLink>Missing destination</ExternalMarkdownLink>);

    expect(fireEvent.click(screen.getByText('Missing destination'))).toBe(true);
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it('contains preload failures instead of surfacing an unhandled click error', async () => {
    const user = userEvent.setup();
    openExternalUrl.mockRejectedValueOnce(new Error('desktop unavailable'));
    render(<ExternalMarkdownLink href="https://forger.ai">Open safely</ExternalMarkdownLink>);

    await expect(user.click(screen.getByRole('link', { name: 'Open safely' }))).resolves.toBeUndefined();
    expect(openExternalUrl).toHaveBeenCalledOnce();
  });
});
