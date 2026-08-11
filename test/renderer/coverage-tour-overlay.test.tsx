import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { getDictionary } from '@renderer/i18n';
import { TourOverlay } from '@renderer/tour/TourOverlay';

const t = getDictionary('en');

describe('TourOverlay', () => {
  it('renders nothing when the tour is inactive', () => {
    const { container } = render(
      <TourOverlay
        step={null}
        highlightRect={null}
        modalWidth={420}
        primaryLabel="Continue"
        primaryVariant="contained"
        primaryColor="primary"
        t={t}
        onSkip={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the centered welcome experience and both actions', async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn();
    const onContinue = vi.fn();
    render(
      <TourOverlay
        step={{ id: 'welcome', title: 'Welcome to Forger', body: 'A short guided tour.' }}
        highlightRect={null}
        modalWidth={420}
        primaryLabel="Start"
        primaryVariant="contained"
        primaryColor="primary"
        t={t}
        extraContent={<div>Privacy choice</div>}
        onSkip={onSkip}
        onContinue={onContinue}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Welcome to Forger' })).toBeVisible();
    expect(screen.getByText('A short guided tour.')).toBeVisible();
    expect(screen.getByText('Privacy choice')).toBeVisible();
    await user.click(screen.getByRole('button', { name: t.onboarding.skip }));
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(onSkip).toHaveBeenCalledOnce();
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('positions an ordinary untargeted step without optional content', () => {
    render(
      <TourOverlay
        step={{ id: 'cloud', title: 'Cloud', body: 'Connect only if useful.' }}
        highlightRect={null}
        modalWidth={360}
        primaryLabel="Next"
        primaryVariant="outlined"
        primaryColor="inherit"
        t={t}
        onSkip={vi.fn()}
        onContinue={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Cloud' })).toBeVisible();
    expect(screen.queryByText('Privacy choice')).not.toBeInTheDocument();
  });

  it('highlights a concrete target and keeps the step actions available', async () => {
    const user = userEvent.setup();
    const onContinue = vi.fn();
    const rect = new DOMRect(40, 60, 320, 80);
    render(
      <TourOverlay
        step={{ id: 'apps', title: 'Your apps', body: 'Open a local app.', target: 'nav-apps' }}
        highlightRect={rect}
        modalWidth={380}
        primaryLabel="Done"
        primaryVariant="contained"
        primaryColor="primary"
        t={t}
        onSkip={vi.fn()}
        onContinue={onContinue}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Your apps' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });
});
