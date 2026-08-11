import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@renderer/App';
import RendererApp from '@renderer/app/RendererApp';
import { DesktopUpdateSummaryMarkdown } from '@renderer/app/DesktopUpdateSummaryMarkdown';
import { AppsGrid } from '@renderer/components/AppsGrid';

const shellSpies = vi.hoisted(() => ({
  controller: vi.fn(() => ({ section: 'catalog', ready: true })),
  view: vi.fn(),
}));

vi.mock('@renderer/app/RendererAppController', () => ({
  useRendererAppController: shellSpies.controller,
}));

vi.mock('@renderer/app/RendererAppView', () => ({
  RendererAppView: ({ controller }: { controller: unknown }) => {
    shellSpies.view(controller);
    return <main>Forger shell</main>;
  },
}));

beforeEach(() => {
  shellSpies.controller.mockClear();
  shellSpies.view.mockClear();
});

describe('small renderer shell surfaces', () => {
  it('passes the controller to the renderer view through both public app entries', () => {
    const first = render(<RendererApp />);
    expect(screen.getByRole('main')).toHaveTextContent('Forger shell');
    expect(shellSpies.controller).toHaveBeenCalledOnce();
    expect(shellSpies.view).toHaveBeenLastCalledWith({ section: 'catalog', ready: true });
    first.unmount();

    render(<App />);
    expect(screen.getByRole('main')).toHaveTextContent('Forger shell');
    expect(shellSpies.controller).toHaveBeenCalledTimes(2);
  });

  it('renders a responsive app grid without changing child semantics', () => {
    render(
      <AppsGrid>
        <article>First app</article>
        <article>Second app</article>
      </AppsGrid>,
    );
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.getByText('First app').parentElement).toHaveClass('MuiBox-root');
  });

  it('renders rich desktop update notes and delegates safe external links', async () => {
    const user = userEvent.setup();
    const onOpenExternalUrl = vi.fn();
    render(
      <DesktopUpdateSummaryMarkdown
        content={'# Update\n\n- Faster startup\n- Better **security**\n\n`npm test`\n\n> Important\n\n[Release notes](https://example.com/release)'}
        onOpenExternalUrl={onOpenExternalUrl}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Update' })).toBeVisible();
    expect(screen.getByText('npm test')).toBeVisible();
    expect(screen.getByText('Important')).toBeVisible();
    await user.click(screen.getByRole('link', { name: 'Release notes' }));
    expect(onOpenExternalUrl).toHaveBeenCalledWith('https://example.com/release');
  });

  it('boots the root renderer into React strict mode', async () => {
    const renderRoot = vi.fn();
    const createRoot = vi.fn(() => ({ render: renderRoot }));
    vi.resetModules();
    vi.doMock('react-dom/client', () => ({ default: { createRoot } }));
    document.body.innerHTML = '<div id="root"></div>';
    await import('@renderer/main');
    expect(createRoot).toHaveBeenCalledWith(document.getElementById('root'));
    expect(renderRoot).toHaveBeenCalledOnce();
    const strictElement = renderRoot.mock.calls[0][0] as { type: symbol; props: { children: { type: unknown } } };
    expect(strictElement.type).toBe(Symbol.for('react.strict_mode'));
    expect(strictElement.props.children.type).toBeTypeOf('function');
    vi.doUnmock('react-dom/client');
  });
});
