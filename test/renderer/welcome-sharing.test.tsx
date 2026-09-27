import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { CampaignMeasurementStatus } from '@shared/campaign-measurement';
import { WelcomeSharingOption } from '@renderer/components/WelcomeSharingOption';
import { useWelcomeSharing } from '@renderer/tour/useWelcomeSharing';
import { TourOverlay } from '@renderer/tour/TourOverlay';
import { getDictionary } from '@renderer/i18n';

const initialize = vi.fn();
vi.mock('@renderer/campaign-measurement', () => ({ initializeCampaignMeasurement: () => initialize(), MEASUREMENT_CHANGED_EVENT: 'measurement-changed', MEASUREMENT_LINK_EVENT: 'measurement-link' }));
const initial: CampaignMeasurementStatus = { available: true, consent: 'undecided', campaignCode: null, attributionLocked: false, newProfile: true };
const consent = vi.fn();
const advance = vi.fn();
const skip = vi.fn();
function Welcome({ locale = 'en', active = true }: { locale?: string; active?: boolean }) {
  const sharing = useWelcomeSharing({ active });
  const dictionary = getDictionary(locale === 'es' ? 'es' : 'en');
  return <TourOverlay step={{ id: 'welcome', title: 'Welcome', body: 'Welcome body' }}
    highlightRect={null} modalWidth={360} primaryLabel="Continue" primaryVariant="contained" primaryColor="primary"
    t={{ ...dictionary, onboarding: { ...dictionary.onboarding, skip: 'Skip' } }}
    extraContent={<WelcomeSharingOption locale={locale} sharing={sharing} />}
    actionsDisabled={sharing.actionsDisabled}
    onContinue={() => void sharing.complete(advance)} onSkip={() => void sharing.complete(skip)} />;
}
const checkbox = () => screen.getByRole('checkbox', { name: 'Share usage data without private information' });
async function ready() { await waitFor(() => expect(checkbox()).toBeEnabled()); }
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  initialize.mockResolvedValue(initial);
  consent.mockImplementation(async (input) => ({ ...initial, consent: input.enabled ? 'enabled' : 'disabled' }));
  Object.defineProperty(window, 'forger', { configurable: true, value: { getCampaignMeasurementStatus: vi.fn(async () => initial), setCampaignMeasurementConsent: consent } });
});

describe('welcome sharing asynchronous lifecycle', () => {
  it('ignores inactive, loading, duplicate save and premature fallback actions', async () => {
    const load = deferred<CampaignMeasurementStatus>();
    initialize.mockReturnValueOnce(load.promise);
    const hook = renderHook(({ active }) => useWelcomeSharing({ active }), { initialProps: { active: false } });
    await act(async () => { await hook.result.current.complete(advance); hook.result.current.continueWithoutSaving(); });
    hook.rerender({ active: true });
    await act(async () => { await hook.result.current.complete(advance); hook.result.current.continueWithoutSaving(); });
    expect(consent).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled();
    await act(async () => load.resolve(initial));
    const save = deferred<CampaignMeasurementStatus>(); consent.mockReturnValueOnce(save.promise);
    let first!: Promise<void>;
    act(() => { first = hook.result.current.complete(advance); });
    await act(async () => { await hook.result.current.complete(skip); });
    await act(async () => { save.reject(new Error('disk full')); await first; });
    expect(hook.result.current.saveFailed).toBe(true);
    act(() => { hook.result.current.continueWithoutSaving(); hook.result.current.continueWithoutSaving(); });
    expect(consent).toHaveBeenCalledOnce(); expect(advance).toHaveBeenCalledOnce(); expect(skip).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('does not advance when a consent write settles by %s after unmount', async (settle) => {
    const save = deferred<CampaignMeasurementStatus>(); consent.mockReturnValueOnce(save.promise);
    const hook = renderHook(() => useWelcomeSharing({ active: true }));
    await waitFor(() => expect(hook.result.current.actionsDisabled).toBe(false));
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.complete(advance); });
    hook.unmount();
    await act(async () => {
      if (settle === 'resolve') save.resolve({ ...initial, consent: 'enabled' });
      else save.reject(new Error('disk full'));
      await pending;
    });
    expect(advance).not.toHaveBeenCalled();
  });

  it('ignores a retained completion callback after an unavailable welcome is unmounted', async () => {
    initialize.mockResolvedValue({ ...initial, available: false });
    const hook = renderHook(() => useWelcomeSharing({ active: true }));
    await waitFor(() => expect(hook.result.current.actionsDisabled).toBe(false));
    const complete = hook.result.current.complete;
    hook.unmount();
    await act(async () => { await complete(advance); });
    expect(consent).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('ignores initialization that settles by %s after leaving welcome', async (settle) => {
    const load = deferred<CampaignMeasurementStatus>(); initialize.mockReturnValueOnce(load.promise);
    const hook = renderHook(() => useWelcomeSharing({ active: true }));
    hook.unmount();
    await act(async () => {
      if (settle === 'resolve') load.resolve(initial);
      else load.reject(new Error('offline'));
    });
    expect(consent).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled();
  });

  it('keeps the latest external choice when older refreshes and initialization finish late', async () => {
    const load = deferred<CampaignMeasurementStatus>(); initialize.mockReturnValueOnce(load.promise);
    const first = deferred<CampaignMeasurementStatus>();
    const staleFailure = deferred<CampaignMeasurementStatus>();
    const latest = deferred<CampaignMeasurementStatus>();
    vi.mocked(window.forger.getCampaignMeasurementStatus)
      .mockReturnValueOnce(first.promise).mockReturnValueOnce(staleFailure.promise).mockReturnValueOnce(latest.promise);
    const hook = renderHook(() => useWelcomeSharing({ active: true }));
    act(() => {
      window.dispatchEvent(new Event('measurement-changed'));
      window.dispatchEvent(new Event('measurement-changed'));
      window.dispatchEvent(new Event('measurement-changed'));
    });
    await act(async () => { latest.resolve({ ...initial, consent: 'disabled' }); });
    await act(async () => { first.resolve(initial); staleFailure.reject(new Error('offline')); load.reject(new Error('offline')); });
    expect(hook.result.current.checked).toBe(false); expect(hook.result.current.loadFailed).toBe(false);
    await act(async () => { await hook.result.current.complete(advance); });
    expect(consent).not.toHaveBeenCalled(); expect(advance).toHaveBeenCalledOnce();
  });

  it('allows continuing when the latest refresh fails, and ignores a refresh rejected after unmount', async () => {
    const load = deferred<CampaignMeasurementStatus>(); initialize.mockReturnValueOnce(load.promise);
    const latest = deferred<CampaignMeasurementStatus>();
    const late = deferred<CampaignMeasurementStatus>();
    vi.mocked(window.forger.getCampaignMeasurementStatus).mockReturnValueOnce(latest.promise).mockReturnValueOnce(late.promise);
    const hook = renderHook(() => useWelcomeSharing({ active: true }));
    act(() => { window.dispatchEvent(new Event('measurement-changed')); });
    await act(async () => { latest.reject(new Error('offline')); });
    expect(hook.result.current.loadFailed).toBe(true); expect(hook.result.current.actionsDisabled).toBe(false);
    act(() => { window.dispatchEvent(new Event('measurement-changed')); });
    hook.unmount();
    await act(async () => { late.reject(new Error('offline')); load.resolve(initial); });
    expect(consent).not.toHaveBeenCalled();
  });
});

describe('welcome sharing choice', () => {
  it('waits for real status, then preselects new consent without saving; details are collapsed and accessible', async () => {
    const load = deferred<CampaignMeasurementStatus>(); initialize.mockReturnValueOnce(load.promise);
    render(<Welcome />);
    expect(checkbox()).toBeDisabled();
    expect(checkbox()).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await act(async () => load.resolve(initial));
    await ready(); expect(checkbox()).toBeChecked();
    expect(screen.queryByText(/PostHog/)).not.toBeInTheDocument();
    const details = screen.getByRole('button', { name: 'Learn more…' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    expect(screen.getByText(/PostHog/)).toBeVisible();
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(details.getAttribute('aria-controls')!)).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(consent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    await waitFor(() => expect(screen.queryByText(/PostHog/)).not.toBeInTheDocument());
  });

  it.each(['Continue', 'Skip'])('persists acceptance before %s and ignores duplicate clicks', async (action) => {
    const save = deferred<CampaignMeasurementStatus>(); consent.mockReturnValueOnce(save.promise);
    render(<Welcome />); await ready();
    fireEvent.click(screen.getByRole('button', { name: action }));
    fireEvent.click(screen.getByRole('button', { name: action }));
    expect(consent).toHaveBeenCalledExactlyOnceWith({ enabled: true });
    expect(advance).not.toHaveBeenCalled(); expect(skip).not.toHaveBeenCalled();
    expect(checkbox()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeDisabled();
    await act(async () => save.resolve({ ...initial, consent: 'enabled' }));
    expect(action === 'Continue' ? advance : skip).toHaveBeenCalledOnce();
  });

  it('unchecking is local until continuing, then saves refusal', async () => {
    render(<Welcome />); await ready(); fireEvent.click(checkbox());
    expect(consent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(advance).toHaveBeenCalledOnce());
    expect(consent).toHaveBeenCalledWith({ enabled: false });
  });

  it.each(['enabled', 'disabled'] as const)('preserves previous %s choice and does not rewrite it', async (choice) => {
    initialize.mockResolvedValue({ ...initial, consent: choice });
    render(<Welcome />); await ready();
    expect((checkbox() as HTMLInputElement).checked).toBe(choice === 'enabled');
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(skip).toHaveBeenCalledOnce());
    expect(consent).not.toHaveBeenCalled();
  });

  it('keeps welcome open on failed persistence and retries the chosen refusal', async () => {
    consent.mockRejectedValueOnce(new Error('disk full'));
    render(<Welcome />); await ready(); fireEvent.click(checkbox());
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your choice. Try again.');
    expect(skip).not.toHaveBeenCalled(); expect(checkbox()).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(skip).toHaveBeenCalledOnce());
    expect(consent).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('persists the revised draft after a failed withdrawal even when it matches the original status', async () => {
    initialize.mockResolvedValue({ ...initial, consent: 'enabled' });
    consent.mockRejectedValueOnce(new Error('disk full'));
    render(<Welcome />); await ready(); fireEvent.click(checkbox());
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('alert');
    fireEvent.click(checkbox());
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(advance).toHaveBeenCalledOnce());
    expect(consent).toHaveBeenCalledTimes(2);
    expect(consent).toHaveBeenNthCalledWith(1, { enabled: false });
    expect(consent).toHaveBeenNthCalledWith(2, { enabled: true });
  });

  it.each(['Continue', 'Skip'])('can finish %s without another write after a failure', async (action) => {
    consent.mockRejectedValueOnce(new Error('disk full'));
    render(<Welcome />); await ready();
    expect(screen.queryByRole('button', { name: 'Continue without saving' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: action }));
    const fallback = await screen.findByRole('button', { name: 'Continue without saving' });
    fireEvent.click(fallback); fireEvent.click(fallback);
    expect(consent).toHaveBeenCalledOnce();
    expect(action === 'Continue' ? advance : skip).toHaveBeenCalledOnce();
    expect(action === 'Continue' ? skip : advance).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'failed'] as const)('continues without sharing when status is %s', async (mode) => {
    if (mode === 'failed') initialize.mockRejectedValueOnce(new Error('offline'));
    else initialize.mockResolvedValue({ ...initial, available: false, consent: 'enabled' });
    render(<Welcome />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    expect(checkbox()).toBeDisabled(); expect(checkbox()).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(advance).toHaveBeenCalledOnce(); expect(consent).not.toHaveBeenCalled();
  });

  it('reflects an external refusal and ignores stale initialization without overwriting it', async () => {
    const load = deferred<CampaignMeasurementStatus>(); initialize.mockReturnValueOnce(load.promise);
    vi.mocked(window.forger.getCampaignMeasurementStatus).mockResolvedValue({ ...initial, consent: 'disabled' });
    render(<Welcome />);
    await act(async () => { window.dispatchEvent(new Event('measurement-changed')); });
    await ready(); expect(checkbox()).not.toBeChecked();
    await act(async () => load.resolve(initial));
    expect(checkbox()).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(consent).not.toHaveBeenCalled(); expect(advance).toHaveBeenCalledOnce();
  });

  it('preserves an explicit campaign source by omitting a new code from the welcome decision', async () => {
    initialize.mockResolvedValue({ ...initial, campaignCode: 'ig_202609_paid_01' });
    render(<Welcome />); await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(advance).toHaveBeenCalledOnce());
    expect(consent).toHaveBeenCalledExactlyOnceWith({ enabled: true });
  });

  it('explains unavailable and unknown state only in details without promising disabled sharing for unknown state', async () => {
    initialize.mockRejectedValueOnce(new Error('offline'));
    render(<Welcome />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Learn more…' }));
    expect(screen.getByText(/could not check your sharing preference/)).toBeVisible();
    expect(screen.queryByText(/Sharing is unavailable/)).not.toBeInTheDocument();
  });

  it('localizes the compact choice and details in Spanish', async () => {
    render(<Welcome locale="es" />);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Compartir datos de uso sin información privada' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Ver más…' }));
    expect(screen.getByText(/primera apertura y primera app creada/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ver menos' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not initialize outside welcome and refreshes real choices on reopening', async () => {
    const view = render(<Welcome active={false} />); expect(initialize).not.toHaveBeenCalled();
    view.rerender(<Welcome />); await ready();
    view.rerender(<Welcome active={false} />);
    initialize.mockResolvedValue({ ...initial, consent: 'disabled' });
    view.rerender(<Welcome />); await ready(); expect(checkbox()).not.toBeChecked();
  });
});
