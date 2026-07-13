import type { SidekickScreenInput, SidekickSpeakInput } from '../shared/types';
import { DesktopRuntimeBridgeError } from './desktop-runtime-bridge-error';
import type { SidekickService } from './sidekick-service';

interface SidekickRuntimeDevice {
  sidekickId: string;
  name: string;
  status: 'offline' | 'usb_detected' | 'pairing' | 'wifi_pending' | 'online' | 'error';
  capabilities: string[];
}

interface SidekickRuntimeResult {
  success: boolean;
  playbackId?: string;
  samplesPlayed?: number;
  underruns?: number;
  droppedChunks?: number;
  userMessage?: string;
  technicalCode?: string;
}

export interface SidekickRuntimeBridgeOptions {
  getAppPlatformCapabilities?: (appId: string) => Promise<{
    textToSpeech: boolean;
    sidekickDisplay?: boolean;
    sidekickSpeech?: boolean;
  }>;
  listSidekicksForApp?: (appId: string) => Promise<SidekickRuntimeDevice[]>;
  sendSidekickScreen?: (appId: string, input: SidekickScreenInput) => Promise<SidekickRuntimeResult>;
  speakThroughSidekick?: (appId: string, input: SidekickSpeakInput) => Promise<SidekickRuntimeResult>;
}

export const createSidekickRuntimeBridgeBindings = (
  getSidekickService: () => SidekickService,
): Pick<SidekickRuntimeBridgeOptions, 'listSidekicksForApp' | 'sendSidekickScreen' | 'speakThroughSidekick'> => ({
  listSidekicksForApp: async () => {
    const state = await getSidekickService().getState();
    return state.sidekicks.map(({ sidekickId, name, status, capabilities }) =>
      ({ sidekickId, name, status, capabilities: [...capabilities] }));
  },
  sendSidekickScreen: async (_appId, input) => {
    const result = await getSidekickService().sendScreen(input);
    return { success: result.success, ...(result.userMessage ? { userMessage: result.userMessage } : {}),
      ...(result.technicalCode ? { technicalCode: result.technicalCode } : {}) };
  },
  speakThroughSidekick: async (_appId, input) => await getSidekickService().speak(input),
});

const TEMPLATES = new Set(['idle', 'state', 'card', 'transcript']);
const ICONS = new Set([
  'listening', 'thinking', 'speaking', 'sleeping', 'error', 'bell', 'info', 'audio', 'wifi', 'warning',
  'ok', 'battery', 'settings', 'home', 'download', 'upload', 'play', 'pause',
]);
const STATE_ICONS = new Set(['listening', 'transcribing', 'thinking', 'speaking', 'sleeping', 'error']);

const fail = (status: number, code: string): never => { throw new DesktopRuntimeBridgeError(status, code); };
const clean = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const bounded = (value: unknown, max: number): string | undefined => {
  if (value === undefined) return undefined;
  const result = clean(value);
  return result && result.length <= max ? result : undefined;
};
const parseBody = (bodyText: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(bodyText) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : fail(400, 'desktop_runtime_body_invalid');
  } catch (error) {
    if (error instanceof DesktopRuntimeBridgeError) throw error;
    return fail(400, 'desktop_runtime_body_invalid');
  }
};

const screenInput = (body: Record<string, unknown>): SidekickScreenInput => {
  const sidekickId = bounded(body.sidekickId, 128);
  const template = clean(body.template);
  const icon = bounded(body.icon, 32);
  const title = bounded(body.title, 96);
  const contentBody = bounded(body.body, 512);
  const text = bounded(body.text, 4000);
  const invalidOptional = (key: 'icon' | 'title' | 'body' | 'text', value?: string) => body[key] !== undefined && value === undefined;
  if (!sidekickId || !TEMPLATES.has(template) || invalidOptional('icon', icon) || invalidOptional('title', title)
    || invalidOptional('body', contentBody) || invalidOptional('text', text) || (icon !== undefined && !ICONS.has(icon))
    || (template === 'state' && (!icon || !STATE_ICONS.has(icon))) || (template === 'card' && !icon)) {
    return fail(400, 'desktop_runtime_sidekick_screen_invalid');
  }
  return { sidekickId, template: template as SidekickScreenInput['template'], ...(icon ? { icon: icon as SidekickScreenInput['icon'] } : {}),
    ...(title ? { title } : {}), ...(contentBody ? { body: contentBody } : {}), ...(text ? { text } : {}) };
};

const speakInput = (body: Record<string, unknown>): SidekickSpeakInput => {
  const sidekickId = bounded(body.sidekickId, 128);
  const text = bounded(body.text, 2000);
  const model = bounded(body.model, 128);
  const voice = bounded(body.voice, 128);
  const speed = body.speed;
  if (!sidekickId || !text || !model || !voice
    || (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2))) {
    return fail(400, 'desktop_runtime_sidekick_speech_invalid');
  }
  return { sidekickId, text, model, voice, ...(typeof speed === 'number' ? { speed } : {}) };
};

const safeResult = (result: SidekickRuntimeResult): Record<string, unknown> => ({
  success: result.success === true,
  ...(typeof result.playbackId === 'string' ? { playbackId: result.playbackId } : {}),
  ...(typeof result.samplesPlayed === 'number' ? { samplesPlayed: result.samplesPlayed } : {}),
  ...(typeof result.underruns === 'number' ? { underruns: result.underruns } : {}),
  ...(typeof result.droppedChunks === 'number' ? { droppedChunks: result.droppedChunks } : {}),
  ...(typeof result.userMessage === 'string' ? { userMessage: result.userMessage } : {}),
  ...(typeof result.technicalCode === 'string' ? { technicalCode: result.technicalCode } : {}),
});

export const routeSidekickRuntimeRequest = async (
  options: SidekickRuntimeBridgeOptions,
  appId: string,
  method: string,
  pathname: string,
  bodyText: string,
): Promise<{ handled: boolean; result?: unknown }> => {
  const match = pathname.match(/^\/v1\/apps\/([^/]+)\/sidekicks(?:\/(screen|speak))?$/);
  if (!match) return { handled: false };
  if (decodeURIComponent(match[1]) !== appId) fail(403, 'desktop_runtime_app_forbidden');
  const capabilities = await options.getAppPlatformCapabilities?.(appId);
  const action = match[2] ?? '';
  if (!action) {
    if (method !== 'GET') fail(404, 'desktop_runtime_route_not_found');
    if (!capabilities?.sidekickDisplay && !capabilities?.sidekickSpeech) fail(403, 'desktop_runtime_sidekick_capability_required');
    const listSidekicks = options.listSidekicksForApp;
    if (!listSidekicks) throw new DesktopRuntimeBridgeError(503, 'desktop_runtime_sidekick_unavailable');
    const sidekicks = await listSidekicks(appId);
    return { handled: true, result: { sidekicks: sidekicks.map(({ sidekickId, name, status, capabilities: deviceCapabilities }) =>
      ({ sidekickId, name, status, capabilities: [...deviceCapabilities] })) } };
  }
  if (method !== 'POST') fail(404, 'desktop_runtime_route_not_found');
  const body = parseBody(bodyText);
  if (action === 'screen') {
    if (!capabilities?.sidekickDisplay) fail(403, 'desktop_runtime_sidekickDisplay_capability_required');
    const sendScreen = options.sendSidekickScreen;
    if (!sendScreen) throw new DesktopRuntimeBridgeError(503, 'desktop_runtime_sidekick_unavailable');
    return { handled: true, result: safeResult(await sendScreen(appId, screenInput(body))) };
  }
  if (!capabilities?.sidekickSpeech) fail(403, 'desktop_runtime_sidekickSpeech_capability_required');
  if (!capabilities?.textToSpeech) fail(403, 'desktop_runtime_textToSpeech_capability_required');
  const speak = options.speakThroughSidekick;
  if (!speak) throw new DesktopRuntimeBridgeError(503, 'desktop_runtime_sidekick_unavailable');
  return { handled: true, result: safeResult(await speak(appId, speakInput(body))) };
};
