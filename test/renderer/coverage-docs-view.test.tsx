import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DocsView } from '@renderer/views/DocsView';

vi.mock('@renderer/docs/forger-docs.generated', () => ({
  forgerDocsBundle: {
    title: { en: 'Forger Documentation', es: 'Documentación de Forger' },
    subtitle: { en: 'English product docs', es: 'Documentación del producto' },
    docs: {
      en: [
        {
          slug: 'first',
          lang: 'en',
          path: 'content/en/first.md',
          title: 'First Doc',
          description: 'The starting guide',
          section: 'Start',
          order: 1,
          status: 'available',
          owner: 'forger',
          sources: [],
          headings: [
            { level: 2, title: 'Áccent `Code`', id: 'accent-code' },
            { level: 3, title: 'Deep Dive', id: 'deep-dive' },
            { level: 4, title: 'Tiny Detail', id: 'tiny-detail' },
            { level: 2, title: 'Missing Target', id: 'not-rendered' },
          ],
          body: 'Intro paragraph.\n\n## Áccent `Code`\n\nRead the [safe site](https://example.test/docs).\n\n### Deep Dive\n\nDetails.\n\n#### Tiny Detail\n\nSmall.\n\n## !!!\n\nFallback heading.',
          html: '',
        },
        {
          slug: 'second',
          lang: 'en',
          path: 'content/en/second.md',
          title: 'Second Doc',
          description: 'Advanced workflows',
          section: 'Advanced',
          order: 2,
          status: 'available',
          owner: 'forger',
          sources: [],
          headings: [{ level: 2, title: 'Beta Heading', id: 'beta-heading' }],
          body: 'Second body.\n\n## Beta Heading\n\nBeta content.',
          html: '',
        },
      ],
      es: [
        {
          slug: 'inicio',
          lang: 'es',
          path: 'content/es/inicio.md',
          title: 'Inicio',
          description: 'Guía inicial',
          section: 'Inicio',
          order: 1,
          status: 'available',
          owner: 'forger',
          sources: [],
          headings: [{ level: 2, title: 'Bienvenida', id: 'bienvenida' }],
          body: 'Texto inicial.\n\n## Bienvenida\n\nContenido.',
          html: '',
        },
      ],
    },
  },
}));

describe('DocsView', () => {
  it('searches documents, expands navigation, and opens a document', async () => {
    const user = userEvent.setup();
    render(<DocsView locale="en" onOpenExternalUrl={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'Forger Documentation' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'First Doc' })).toBeVisible();
    const search = screen.getByPlaceholderText('Search docs');

    await user.type(search, 'advanced workflows');
    expect(screen.queryByText('First Doc', { selector: '.MuiListItemText-primary' })).not.toBeInTheDocument();
    expect(screen.getByText('Second Doc', { selector: '.MuiListItemText-primary' })).toBeVisible();

    await user.clear(search);
    await user.click(screen.getAllByRole('button', { name: 'Collapse section' })[0]);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Deep Dive' })).not.toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: 'Expand section' })[0]);
    expect(await screen.findByRole('button', { name: 'Deep Dive' })).toBeVisible();

    const secondNav = screen.getByText('Second Doc', { selector: '.MuiListItemText-primary' });
    await user.click(secondNav.closest('.MuiListItemButton-root') as HTMLElement);
    expect(screen.getByRole('heading', { name: 'Second Doc' })).toBeVisible();
    expect(screen.getByText('Beta content.')).toBeVisible();
  });

  it('renders stable markdown anchors and delegates external links', async () => {
    const user = userEvent.setup();
    const onOpenExternalUrl = vi.fn();
    render(<DocsView locale="en" onOpenExternalUrl={onOpenExternalUrl} />);

    expect(screen.getByRole('heading', { name: 'Áccent Code' })).toHaveAttribute('id', 'accent-code');
    expect(screen.getByRole('heading', { name: 'Deep Dive' })).toHaveAttribute('id', 'deep-dive');
    expect(screen.getByRole('heading', { name: 'Tiny Detail' })).toHaveAttribute('id', 'tiny-detail');
    expect(screen.getByRole('heading', { name: '!!!' })).toHaveAttribute('id', 'section');

    await user.click(screen.getByRole('link', { name: 'safe site' }));
    expect(onOpenExternalUrl).toHaveBeenCalledWith('https://example.test/docs');
  });

  it('scrolls to selected headings, tolerates a missing target, and cancels pending frames', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 41;
    });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    const view = render(<DocsView locale="en" onOpenExternalUrl={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Deep Dive' }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
    await user.click(screen.getByRole('button', { name: 'Missing Target' }));
    expect(requestFrame).toHaveBeenCalledTimes(2);

    requestFrame.mockImplementation(() => 99);
    await user.click(screen.getByRole('button', { name: 'Áccent `Code`' }));
    view.unmount();
    expect(cancelFrame).toHaveBeenCalledWith(99);
  });

  it('falls back to the first translated document when the locale changes', () => {
    const view = render(<DocsView locale="en" onOpenExternalUrl={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'First Doc' })).toBeVisible();

    view.rerender(<DocsView locale="es" onOpenExternalUrl={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Documentación de Forger' })).toBeVisible();
    expect(screen.getByPlaceholderText('Buscar docs')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Inicio' })).toBeVisible();
  });
});
