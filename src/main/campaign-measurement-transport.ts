export interface CampaignCapturePayload {
  event: 'forger_campaign_first_open' | 'forger_campaign_first_app_created';
  distinct_id: string;
  uuid: string;
  timestamp: string;
  properties: {
    campaign_code: string;
    surface: 'desktop';
    schema_version: 1;
    environment: 'production' | 'test';
    version: string;
    platform: string;
    $process_person_profile: false;
    $geoip_disable: true;
  };
}

export type CampaignCaptureTransport = (payload: CampaignCapturePayload, signal: AbortSignal) => Promise<boolean>;

/** No SDK, cookies, browser URLs, credentials, device properties, or redirect following. */
export const createCampaignCaptureTransport = (
  publicProjectToken: string,
  fetcher: typeof fetch = fetch,
): CampaignCaptureTransport => async (payload, signal) => {
  try {
    const response = await fetcher('https://us.i.posthog.com/i/v0/e/', {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: publicProjectToken, ...payload }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    return response.ok;
  } catch {
    return false;
  }
};
