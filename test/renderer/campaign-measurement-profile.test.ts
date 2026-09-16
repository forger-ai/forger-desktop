import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('campaign profile boundary', () => {
  const initialize = vi.fn();
  const record = vi.fn();
  beforeEach(() => {
    vi.resetModules(); window.localStorage.clear(); initialize.mockReset(); record.mockReset();
    initialize.mockResolvedValue({ available: true, consent: 'undecided', newProfile: true });
    Object.defineProperty(window, 'forger', { configurable: true, value: {
      initializeCampaignMeasurement: initialize,
      getCampaignMeasurementStatus: vi.fn(async () => ({ available: true, consent: 'undecided', newProfile: true })),
      recordCampaignFirstAppCreated: record.mockResolvedValue(undefined),
    } });
  });
  it('snapshots existing profile before other startup writes and initializes only once', async () => {
    const service = await import('@renderer/campaign-measurement');
    window.localStorage.setItem('forger.terms.acceptedAt', 'later startup');
    await Promise.all([service.initializeCampaignMeasurement(), service.initializeCampaignMeasurement()]);
    expect(initialize).toHaveBeenCalledExactlyOnceWith(false);
    expect(window.localStorage.getItem('forger.installation.identifier')).toBeNull();
  });
  it('old profile identifiers are eligibility evidence only, never reused as campaign identity', async () => {
    window.localStorage.setItem('forger.installation.identifier', 'old-private-id');
    const service = await import('@renderer/campaign-measurement');
    await service.initializeCampaignMeasurement();
    expect(initialize).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('unavailable local storage fails closed to existing profile', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const service = await import('@renderer/campaign-measurement');
    await service.initializeCampaignMeasurement();
    expect(initialize).toHaveBeenCalledExactlyOnceWith(true);
    get.mockRestore();
  });
  it('genuine creation crosses the bridge without app content or app identifiers', async () => {
    const service = await import('@renderer/campaign-measurement');
    service.recordCampaignFirstAppCreated();
    await vi.waitFor(() => expect(record).toHaveBeenCalledExactlyOnceWith());
  });
  it('initialization failure can be retried but never silently changes consent', async () => {
    initialize.mockRejectedValueOnce(new Error('disk full'));
    const service = await import('@renderer/campaign-measurement');
    await expect(service.initializeCampaignMeasurement()).rejects.toThrow('disk full');
    await service.initializeCampaignMeasurement();
    expect(initialize).toHaveBeenCalledTimes(2);
  });
  it('unwritable local storage marks the profile existing and creation errors stay non-blocking', async () => {
    const service = await import('@renderer/campaign-measurement');
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await service.initializeCampaignMeasurement(); set.mockRestore();
    expect(initialize).toHaveBeenCalledExactlyOnceWith(true);
    record.mockRejectedValueOnce(new Error('disk full'));
    expect(() => service.recordCampaignFirstAppCreated()).not.toThrow();
    await vi.waitFor(() => expect(record).toHaveBeenCalled());
  });
  it('missing bridges do not send or manufacture identity', async () => {
    Object.defineProperty(window, 'forger', { configurable: true, value: undefined });
    const service = await import('@renderer/campaign-measurement');
    await expect(service.initializeCampaignMeasurement()).rejects.toThrow('measurement_unavailable');
    expect(() => service.recordCampaignFirstAppCreated()).not.toThrow();
  });
});
