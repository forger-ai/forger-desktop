import { createTheme, ThemeProvider } from '@mui/material/styles';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DevicesView } from '@renderer/views/DevicesView';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { CloudDeviceSummary, CloudDevicesState, ForgerAccountSession } from '@shared/types';

const t = en as unknown as AppDictionary;
const account = { authenticated: true } as ForgerAccountSession;
const signedOut = { authenticated: false } as ForgerAccountSession;

const desktop = (overrides: Partial<CloudDeviceSummary> = {}): CloudDeviceSummary => ({
  id: 1,
  deviceUid: 'desktop-1',
  name: 'Studio Desktop',
  kind: 'desktop',
  platform: 'macOS',
  paired: true,
  online: true,
  installedApps: [],
  ...overrides,
});

const mobile = (id: number, name: string, overrides: Partial<CloudDeviceSummary> = {}): CloudDeviceSummary => ({
  id,
  deviceUid: `mobile-${id}`,
  name,
  kind: 'mobile',
  platform: 'iOS',
  paired: true,
  online: false,
  installedApps: [],
  ...overrides,
});

const fullState = (): CloudDevicesState => {
  const current = desktop();
  const requestMobile = mobile(10, 'Waiting phone');
  return {
    currentDevice: current,
    connected: false,
    userMessage: 'Devices loaded.',
    devices: [
      current,
      mobile(20, 'Connected phone'),
      desktop({ id: 30, deviceUid: 'desktop-30', name: 'Travel desktop', online: true, installedApps: [{ id: 'planner', name: 'Planner', status: 'running' }] }),
      desktop({ id: 31, deviceUid: 'desktop-31', name: 'Offline desktop', platform: undefined, online: false }),
    ],
    pairingRequests: [
      { id: 101, mobileDeviceId: 10, desktopDeviceId: 1, status: 'pending', code: '123456', expiresAt: '2026-08-11T10:00:00.000Z', mobileDevice: requestMobile, desktopDevice: current },
      { id: 102, mobileDeviceId: 11, desktopDeviceId: 1, status: 'accepted', expiresAt: '2026-08-11T10:00:00.000Z', mobileDevice: mobile(11, 'Accepted phone', { platform: undefined }), desktopDevice: current },
      { id: 103, mobileDeviceId: 12, desktopDeviceId: 1, status: 'confirmed', expiresAt: '2026-08-11T10:00:00.000Z', mobileDevice: mobile(12, 'Confirmed phone'), desktopDevice: current },
      { id: 104, mobileDeviceId: 13, desktopDeviceId: 1, status: 'rejected', expiresAt: '2026-08-11T10:00:00.000Z', mobileDevice: mobile(13, 'Rejected phone'), desktopDevice: current },
      { id: 105, mobileDeviceId: 14, desktopDeviceId: 1, status: 'expired', expiresAt: '2026-08-11T10:00:00.000Z', mobileDevice: mobile(14, 'Expired phone'), desktopDevice: current },
    ],
    mobileDesktopAuthorizations: [
      { id: 201, mobileDeviceId: 20, desktopDeviceId: 1, active: true, mobileDevice: mobile(20, 'Connected phone', { platform: undefined, online: true }), desktopDevice: current },
      { id: 202, mobileDeviceId: 21, desktopDeviceId: 1, active: true, mobileDevice: mobile(21, 'Offline phone'), desktopDevice: current },
    ],
  };
};

const installForger = (state: CloudDevicesState) => {
  const api = {
    getCloudDevices: vi.fn().mockResolvedValue(state),
    updateCloudDeviceName: vi.fn().mockResolvedValue(state),
    acceptMobilePairingRequest: vi.fn().mockResolvedValue(state),
    rejectMobilePairingRequest: vi.fn().mockResolvedValue(state),
    deleteMobilePairingRequest: vi.fn().mockResolvedValue(state),
    unlinkMobileDeviceFromDesktop: vi.fn().mockResolvedValue(state),
  };
  Object.defineProperty(window, 'forger', { configurable: true, value: api });
  return api;
};

const renderView = (session = account, themeMode: 'light' | 'dark' = 'light') => render(
  <ThemeProvider theme={createTheme({ palette: { mode: themeMode } })}>
    <DevicesView account={session} t={t} />
  </ThemeProvider>,
);

describe('DevicesView', () => {
  it('requires sign-in while still safely loading the cloud device state', async () => {
    const api = installForger({ devices: [], connected: false });
    renderView(signedOut);

    expect(screen.getByText(t.sections.devices.signInRequired)).toBeInTheDocument();
    await waitFor(() => expect(api.getCloudDevices).toHaveBeenCalledOnce());
  });

  it('renders device, request, authorization, and paired-device states and refreshes', async () => {
    const user = userEvent.setup();
    const api = installForger(fullState());
    renderView();

    expect(await screen.findByText('Studio Desktop · Connected')).toBeInTheDocument();
    expect(screen.getByText('Devices loaded.')).toBeInTheDocument();
    expect(screen.getByText('123456')).toBeInTheDocument();
    expect(screen.getByText('Accepted phone')).toBeInTheDocument();
    expect(screen.getByText('Travel desktop')).toBeInTheDocument();
    expect(screen.getByText(`Desktop · ${t.sections.devices.appsCount(0)}`)).toBeInTheDocument();
    expect(screen.getAllByText(t.sections.devices.online).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t.sections.devices.offline).length).toBeGreaterThan(0);

    api.getCloudDevices.mockClear();
    await user.click(screen.getByRole('button', { name: t.sections.devices.refresh }));
    expect(api.getCloudDevices).toHaveBeenCalledOnce();
  });

  it('renames the current desktop and can cancel a later edit', async () => {
    const user = userEvent.setup();
    const updated = fullState();
    updated.currentDevice = desktop({ name: 'Renamed Desktop' });
    updated.devices[0] = updated.currentDevice;
    const api = installForger(fullState());
    api.updateCloudDeviceName.mockResolvedValue(updated);
    renderView();

    await screen.findByText('Studio Desktop · Connected');
    await user.click(screen.getByRole('button', { name: t.sections.devices.editDesktopName }));
    const dialog = screen.getByRole('dialog');
    const name = within(dialog).getByRole('textbox', { name: t.sections.devices.desktopNameLabel });
    expect(name).toHaveValue('Studio Desktop');
    await user.clear(name);
    await user.type(name, 'Renamed Desktop');
    await user.click(within(dialog).getByRole('button', { name: t.sections.devices.desktopNameSave }));
    expect(api.updateCloudDeviceName).toHaveBeenCalledWith({ name: 'Renamed Desktop' });
    expect(await screen.findByText('Renamed Desktop · Connected')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: t.sections.devices.editDesktopName }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.sections.devices.desktopNameCancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: t.sections.devices.editDesktopName }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('accepts, rejects, and removes mobile access requests', async () => {
    const user = userEvent.setup();
    const api = installForger(fullState());
    renderView();
    await screen.findByText('Waiting phone');

    await user.click(screen.getByRole('button', { name: 'Authorize' }));
    expect(api.acceptMobilePairingRequest).toHaveBeenCalledWith(101);
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(api.rejectMobilePairingRequest).toHaveBeenCalledWith(101);
    await user.click(screen.getAllByRole('button', { name: t.sections.devices.deleteRequest })[0]);
    expect(api.deleteMobilePairingRequest).toHaveBeenCalledWith(103);
  });

  it('cancels and confirms unlinking a connected phone', async () => {
    const user = userEvent.setup();
    const api = installForger(fullState());
    renderView();
    await screen.findByText('Connected phone');

    await user.click(screen.getAllByRole('button', { name: t.sections.devices.unlinkMobile })[0]);
    expect(screen.getByText(t.sections.devices.unlinkMobileBody('Connected phone'))).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.sections.devices.unlinkMobileCancel }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: t.sections.devices.unlinkMobile })[0]);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: t.sections.devices.unlinkMobileConfirm }));
    expect(api.unlinkMobileDeviceFromDesktop).toHaveBeenCalledWith(201);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: t.sections.devices.unlinkMobile })[0]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('covers offline, directly connected, empty, success, error, dark-theme, and pending load states', async () => {
    const deferred = Promise.withResolvers<CloudDevicesState>();
    const api = installForger({ devices: [], connected: false });
    api.getCloudDevices.mockReturnValue(deferred.promise);
    const view = renderView();
    expect(screen.getByRole('button', { name: t.sections.devices.refresh })).toBeDisabled();
    deferred.resolve({
      devices: [desktop({ id: 50, deviceUid: 'remote-only', name: 'Remote desktop' })],
      connected: true,
      userMessage: 'Connected directly.',
    });
    expect(await screen.findByText('Forger Desktop · Connected')).toBeInTheDocument();
    expect(screen.getByText('Connected directly.')).toBeInTheDocument();
    expect(screen.getByText('Remote desktop')).toBeInTheDocument();
    view.unmount();

    const darkState = fullState();
    darkState.currentDevice = desktop({ id: 99, deviceUid: 'missing', name: 'Offline current' });
    darkState.devices = [];
    darkState.connected = false;
    darkState.userMessage = 'Could not load devices.';
    darkState.technicalCode = 'network_error';
    installForger(darkState);
    const darkView = renderView(account, 'dark');
    expect(await screen.findByText('Offline current · Not connected')).toBeInTheDocument();
    expect(screen.getByText('Could not load devices.')).toBeInTheDocument();
    expect(screen.getByText('123456')).toBeInTheDocument();
    darkView.unmount();

    const onlyCurrent = desktop();
    installForger({
      currentDevice: onlyCurrent,
      devices: [onlyCurrent],
      connected: false,
      pairingRequests: [],
      mobileDesktopAuthorizations: [],
    });
    renderView();
    expect(await screen.findByText(t.sections.devices.noMobileAccessRequests)).toBeInTheDocument();
    expect(screen.getByText(t.sections.devices.noConnectedMobileDevices)).toBeInTheDocument();
  });
});
