import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CampaignMeasurementDialog, CampaignMeasurementPanel } from '@renderer/components/CampaignMeasurementPanel';

const initial = { available: true, consent: 'undecided' as const, campaignCode: null, attributionLocked: false, newProfile: true };
const initialize = vi.fn();
vi.mock('@renderer/campaign-measurement', () => ({ initializeCampaignMeasurement: () => initialize(), MEASUREMENT_CHANGED_EVENT: 'measurement-changed', MEASUREMENT_LINK_EVENT: 'measurement-link' }));

describe('voluntary campaign measurement', () => {
  let consent: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    let current: Record<string, unknown> = initial;
    initialize.mockResolvedValue(initial);
    consent = vi.fn(async (input) => {
      current = { ...initial, consent: input.enabled ? 'enabled' : 'disabled', campaignCode: input.campaignCode ?? null };
      return current;
    });
    Object.defineProperty(window, 'forger', { configurable: true, value: { getCampaignMeasurementStatus: vi.fn(async () => current), setCampaignMeasurementConsent: consent } });
  });
  it('does not opt in on render and offers equally explicit refusal and acceptance', async () => {
    render(<CampaignMeasurementPanel locale="en" />);
    await screen.findByRole('button', { name: 'Allow measurement' });
    expect(consent).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'No thanks' })).toBeEnabled();
    expect(screen.getByText(/PostHog/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    await waitFor(() => expect(consent).toHaveBeenCalledWith({ enabled: false }));
  });
  it('prefills explicit handoff code without silently accepting, rejects arbitrary text', async () => {
    render(<CampaignMeasurementPanel locale="en" initialCode="ig_202609_paid_01" />);
    const field = await screen.findByLabelText('Campaign code (optional)');
    expect(field).toHaveValue('ig_202609_paid_01');
    expect(consent).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: 'email@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Allow measurement' }));
    expect(consent).not.toHaveBeenCalled();
    expect(screen.getByText(/code is not recognized/)).toBeVisible();
  });
  it('makes withdrawal scope visible and reports unsuccessful persistence without claiming saved', async () => {
    initialize.mockResolvedValue({ ...initial, consent: 'enabled', attributionLocked: true });
    consent.mockRejectedValue(new Error('disk full'));
    render(<CampaignMeasurementPanel locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off measurement' }));
    expect(await screen.findByText(/Could not save/)).toBeVisible();
    expect(screen.getByText(/does not delete data already sent/)).toBeVisible();
  });
  it('accepts a known code or no code only on the explicit button, and allows withdrawal', async () => {
    const view = render(<CampaignMeasurementPanel locale="en" initialCode="ig_202609_paid_01" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow measurement' }));
    await waitFor(() => expect(consent).toHaveBeenCalledWith({ enabled: true, campaignCode: 'ig_202609_paid_01' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off measurement' }));
    expect(await screen.findByText(/Measurement is off/)).toBeVisible();
    view.unmount();
    render(<CampaignMeasurementPanel locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow measurement' }));
    await waitFor(() => expect(consent).toHaveBeenCalledWith({ enabled: true, campaignCode: null }));
  });
  it('shows unavailable builds and fixed attribution clearly in Spanish', async () => {
    initialize.mockResolvedValue({ ...initial, available: false, campaignCode: 'ig_202609_paid_02', attributionLocked: true });
    render(<CampaignMeasurementPanel locale="es" />);
    expect(await screen.findByText(/versiones de desarrollo y pruebas/)).toBeVisible();
    expect(screen.getByLabelText('Código de campaña (opcional)')).toHaveValue('ig_202609_paid_02');
    expect(screen.getByLabelText('Código de campaña (opcional)')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Permitir medición' })).toBeDisabled();
    expect(screen.getByText(/origen de la campaña ya está fijado/)).toBeVisible();
  });
  it('does not display a late incoming code as applied to a previously unattributed first open', async () => {
    initialize.mockResolvedValue({ ...initial, consent: 'enabled', attributionLocked: true });
    render(<CampaignMeasurementPanel locale="en" initialCode="ig_202609_paid_01" />);
    await screen.findByRole('button', { name: 'Turn off measurement' });
    expect(screen.getByLabelText('Campaign code (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Campaign code (optional)')).toBeDisabled();
    expect(screen.getByText(/campaign source is already fixed/)).toBeVisible();
    expect(consent).not.toHaveBeenCalled();
  });
  it('opens only known campaign links without consent, closes with Continue or Escape', async () => {
    const view = render(<CampaignMeasurementDialog locale="en" />);
    act(() => window.dispatchEvent(new CustomEvent('measurement-link', { detail: 'unknown' })));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => window.dispatchEvent(new CustomEvent('measurement-link', { detail: 'ig_202609_paid_01' })));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByLabelText('Campaign code (optional)')).toHaveValue('ig_202609_paid_01');
    expect(consent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    act(() => window.dispatchEvent(new CustomEvent('measurement-link', { detail: 'ig_202609_paid_02' })));
    fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(dialog).not.toBeInTheDocument();
    view.unmount();
    render(<CampaignMeasurementDialog locale="es" />);
  });
  it('handles initialization and refresh errors without auto-consent or unmounted updates', async () => {
    initialize.mockRejectedValueOnce(new Error('unavailable'));
    const failed = render(<CampaignMeasurementPanel locale="en" />);
    expect(await screen.findByText(/Could not save/)).toBeVisible(); failed.unmount();
    initialize.mockResolvedValue(initial);
    const active = render(<CampaignMeasurementPanel locale="en" />);
    await screen.findByRole('button', { name: 'Allow measurement' });
    vi.mocked(window.forger.getCampaignMeasurementStatus).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { window.dispatchEvent(new Event('measurement-changed')); });
    expect(consent).not.toHaveBeenCalled(); active.unmount();
    for (const reject of [false, true]) {
      let settle: (value?: unknown) => void = () => undefined;
      initialize.mockReturnValueOnce(new Promise((resolve, fail) => { settle = reject ? fail : resolve; }));
      const view = render(<CampaignMeasurementPanel locale="en" />); view.unmount();
      await act(async () => { settle(reject ? new Error('late') : initial); });
    }
  });
});
