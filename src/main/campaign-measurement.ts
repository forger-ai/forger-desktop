import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCampaignCode, type CampaignCode, type CampaignMeasurementStatus } from '../shared/campaign-measurement';
import type { CampaignCapturePayload, CampaignCaptureTransport } from './campaign-measurement-transport';

const CONSENT_VERSION = 'posthog-forger-612473-v1';
const MAX_ATTEMPTS = 5;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_DELAYS = [10_000, 60_000, 300_000, 3_600_000];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type EventName = CampaignCapturePayload['event'];
type PendingEvent = { event: EventName; uuid: string; timestamp: string; attempts: number; nextAt: number;
  version: string; platform: string; environment: 'production' | 'test' };
interface MeasurementState {
  consentVersion: typeof CONSENT_VERSION;
  consent: CampaignMeasurementStatus['consent'];
  newProfile: boolean;
  profileId: string | null;
  campaignCode: CampaignCode | null;
  attributionLocked: boolean;
  firstOpenRecorded: boolean;
  firstAppObserved: boolean;
  outbox: PendingEvent[];
}
interface Options {
  filePath: string;
  enabled: boolean;
  environment: 'production' | 'test';
  version: string;
  platform: string;
  send: CampaignCaptureTransport;
  now?: () => number;
}

const emptyState = (newProfile: boolean): MeasurementState => ({
  consentVersion: CONSENT_VERSION, consent: 'undecided', newProfile, profileId: null,
  campaignCode: null, attributionLocked: false, firstOpenRecorded: false, firstAppObserved: false, outbox: [],
});

const decodeState = (raw: string): MeasurementState => {
  if (raw.length > 16_384) throw new Error('invalid_measurement_state');
  const value = JSON.parse(raw) as MeasurementState;
  if (value?.consentVersion !== CONSENT_VERSION
    || !['undecided', 'enabled', 'disabled'].includes(value.consent)
    || !['newProfile', 'attributionLocked', 'firstOpenRecorded', 'firstAppObserved'].every((key) => typeof value[key as keyof MeasurementState] === 'boolean')
    || !(value.profileId === null || (typeof value.profileId === 'string' && UUID.test(value.profileId)))
    || !(value.campaignCode === null || isCampaignCode(value.campaignCode))
    || !Array.isArray(value.outbox) || value.outbox.length > 2
    || (value.outbox.length > 0 && !value.profileId)) throw new Error('invalid_measurement_state');
  const outbox = value.outbox.map((event) => {
    if (!['forger_campaign_first_open', 'forger_campaign_first_app_created'].includes(event.event)
      || !UUID.test(event.uuid) || !Number.isFinite(Date.parse(event.timestamp))
      || !Number.isInteger(event.attempts) || event.attempts < 0 || event.attempts > MAX_ATTEMPTS
      || !Number.isFinite(event.nextAt) || !['test', 'production'].includes(event.environment)
      || typeof event.version !== 'string' || !/^(?:unknown|\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?)$/.test(event.version)
      || !['darwin', 'win32', 'linux', 'unknown'].includes(event.platform)) throw new Error('invalid_measurement_state');
    return { event: event.event, uuid: event.uuid, timestamp: event.timestamp, attempts: event.attempts, nextAt: event.nextAt,
      version: event.version, platform: event.platform, environment: event.environment };
  });
  if (new Set(outbox.map((event) => event.event)).size !== outbox.length) throw new Error('invalid_measurement_state');
  return { consentVersion: CONSENT_VERSION, consent: value.consent, newProfile: value.newProfile,
    profileId: value.profileId, campaignCode: value.campaignCode, attributionLocked: value.attributionLocked,
    firstOpenRecorded: value.firstOpenRecorded, firstAppObserved: value.firstAppObserved,
    outbox: value.consent === 'enabled' ? outbox : [] };
};

/** Owns consent and collection in main. The renderer cannot choose events, identifiers, or destination. */
export class CampaignMeasurement {
  private state: MeasurementState | null = null;
  private initialSession = false;
  private serial: Promise<unknown> = Promise.resolve();
  private activeFlush: Promise<void> | null = null;
  private request: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private paused = false;
  private readonly now: () => number;

  constructor(private readonly options: Options) { this.now = options.now ?? Date.now; }

  private async load(existingProfile: unknown = true) {
    if (this.state) return;
    try {
      this.state = decodeState(await fs.readFile(this.options.filePath, 'utf8'));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      this.initialSession = missing && existingProfile === false;
      this.state = emptyState(this.initialSession);
      if (!missing) this.state.consent = 'disabled';
    }
    try {
      await fs.stat(`${this.options.filePath}.withdrawn`);
      this.state = { ...emptyState(false), consent: 'disabled' };
      this.initialSession = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.state = { ...emptyState(false), consent: 'disabled' };
        this.initialSession = false;
      }
    }
  }

  private async save() {
    await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
    const temporaryPath = `${this.options.filePath}.tmp`;
    await fs.writeFile(temporaryPath, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, this.options.filePath);
  }

  private transaction<T>(action: () => Promise<T>): Promise<T> {
    const next = this.serial.then(action);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private status(): CampaignMeasurementStatus {
    const state = this.state!;
    return { available: this.options.enabled, consent: state.consent, campaignCode: state.campaignCode,
      attributionLocked: state.attributionLocked, newProfile: state.newProfile };
  }

  async initialize(existingProfile: unknown = true, hasExistingApps = false) {
    const result = await this.transaction(async () => {
      await this.load(existingProfile);
      // A restored registry is authoritative even if the original observation failed to persist.
      if (hasExistingApps) this.state!.firstAppObserved = true;
      await this.save();
      return this.status();
    });
    this.schedule();
    return result;
  }

  async getStatus() {
    return this.transaction(async () => { await this.load(); return this.status(); });
  }

  private enqueue(event: EventName) {
    const state = this.state!;
    state.profileId ??= randomUUID();
    state.attributionLocked = true; // Freeze before any attempt, including ambiguous network failures.
    state.outbox.push({ event, uuid: randomUUID(), timestamp: new Date(this.now()).toISOString(), attempts: 0, nextAt: this.now(),
      environment: this.options.environment,
      version: /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(this.options.version) ? this.options.version : 'unknown',
      platform: ['darwin', 'win32', 'linux'].includes(this.options.platform) ? this.options.platform : 'unknown' });
  }

  async setConsent(enabled: boolean, campaignCode?: unknown) {
    if (typeof enabled !== 'boolean') throw new Error('invalid_consent');
    if (campaignCode !== undefined && campaignCode !== null && !isCampaignCode(campaignCode)) throw new Error('invalid_campaign');
    if (!enabled) { this.paused = true; this.request?.abort(); }
    const result = await this.transaction(async () => {
      await this.load();
      const state = this.state!;
      if (!enabled) {
        this.request?.abort();
        state.consent = 'disabled';
        state.outbox = [];
        state.profileId = null;
        state.campaignCode = null;
        state.attributionLocked = false;
        state.newProfile = false;
        this.initialSession = false;
        // This tiny independent marker overrides a stale enabled file after a failed state write.
        let markerSaved = false;
        try {
          await fs.mkdir(path.dirname(this.options.filePath), { recursive: true });
          await fs.writeFile(`${this.options.filePath}.withdrawn`, '', { mode: 0o600 });
          markerSaved = true;
        } catch { /* Still attempt the full disabled state write below. */ }
        try { await this.save(); } catch (error) {
          if (!markerSaved) throw error;
          // Marker already makes withdrawal durable. Also remove stale local identity/outbox bytes.
          await fs.rm(this.options.filePath, { force: true });
          await fs.rm(`${this.options.filePath}.tmp`, { force: true });
        }
        return this.status();
      } else if (this.options.enabled) {
        if (state.attributionLocked && campaignCode !== undefined && campaignCode !== state.campaignCode) throw new Error('campaign_locked');
        if (!state.attributionLocked && campaignCode !== undefined) state.campaignCode = campaignCode as CampaignCode | null;
        state.consent = 'enabled';
        if (state.newProfile && this.initialSession && !state.firstOpenRecorded) {
          state.firstOpenRecorded = true;
          this.enqueue('forger_campaign_first_open');
        }
      }
      try {
        await this.save();
        if (enabled) {
          await fs.rm(`${this.options.filePath}.withdrawn`, { force: true });
          this.paused = false;
        }
      } catch (error) {
        state.consent = 'disabled'; state.outbox = []; state.profileId = null; state.newProfile = false;
        this.paused = true;
        throw error;
      }
      return this.status();
    });
    this.schedule();
    return result;
  }

  async recordFirstAppCreated() {
    await this.transaction(async () => {
      await this.load();
      const state = this.state!;
      if (state.firstAppObserved) return;
      state.firstAppObserved = true;
      if (this.options.enabled && state.newProfile && state.firstOpenRecorded && state.consent === 'enabled') this.enqueue('forger_campaign_first_app_created');
      try { await this.save(); } catch (error) {
        this.paused = true;
        this.request?.abort();
        state.consent = 'disabled'; state.outbox = []; state.profileId = null; state.newProfile = false;
        await fs.writeFile(`${this.options.filePath}.withdrawn`, '', { mode: 0o600 }).catch(() => undefined);
        throw error;
      }
    });
    this.schedule();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.closed || this.paused || !this.options.enabled || this.state?.consent !== 'enabled' || !this.state.outbox.length) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush().catch(() => undefined); },
      Math.max(10, this.state.outbox[0].nextAt - this.now()));
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    this.activeFlush = this.drain().finally(() => { this.activeFlush = null; this.schedule(); });
    return this.activeFlush;
  }

  private async drain() {
    while (!this.closed) {
      const pending = await this.transaction(async () => {
        await this.load();
        const state = this.state!;
        if (this.paused || !this.options.enabled || state.consent !== 'enabled' || !state.profileId) return null;
        state.outbox = state.outbox.filter((event) => event.attempts < MAX_ATTEMPTS && this.now() - Date.parse(event.timestamp) < MAX_AGE_MS);
        const entry = state.outbox[0];
        if (!entry || entry.nextAt > this.now()) { await this.save(); return null; }
        entry.attempts += 1;
        entry.nextAt = this.now() + (RETRY_DELAYS[Math.min(entry.attempts - 1, RETRY_DELAYS.length - 1)]);
        await this.save(); // Persist UUID and attempt before network, so crashes cannot create a new event.
        const payload: CampaignCapturePayload = { event: entry.event, uuid: entry.uuid, distinct_id: state.profileId,
          timestamp: entry.timestamp, properties: { campaign_code: state.campaignCode ?? 'unattributed', surface: 'desktop',
            schema_version: 1, environment: entry.environment, version: entry.version, platform: entry.platform,
            $process_person_profile: false, $geoip_disable: true } };
        this.request = new AbortController();
        return { payload, signal: this.request.signal };
      });
      if (!pending || this.paused || pending.signal.aborted || this.state?.consent !== 'enabled') return;
      let sent = false;
      try { sent = await this.options.send(pending.payload, pending.signal); } catch { /* bounded retry, no sensitive logging */ }
      this.request = null;
      await this.transaction(async () => {
        const state = this.state!;
        if (sent) state.outbox = state.outbox.filter((event) => event.uuid !== pending.payload.uuid);
        else state.outbox = state.outbox.filter((event) => event.attempts < MAX_ATTEMPTS);
        await this.save();
      });
      if (!sent) return;
    }
  }

  close() {
    this.closed = true;
    this.request?.abort();
    if (this.timer) clearTimeout(this.timer);
  }
}
