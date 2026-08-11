import { render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalAgentConversation, PersonalAgentMessage, SidekickSummary, TextToSpeechState } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import {
  SidekickConversationDialog,
  SidekickConversationList,
  SidekickVoiceSettings,
} from '@renderer/views/sidekicks/SidekickVoiceExperience';

const copy = getDictionary('en').sections.sidekicks;

const sidekick = (voiceConfig: SidekickSummary['voiceConfig']): SidekickSummary => ({
  sidekickId: 'sidekick-1', name: 'Desk Sidekick', status: 'online', capabilities: [],
  voiceConfig, voicePhase: 'idle', speakerPlayback: { active: false }, microphoneRecording: { active: false },
  microphoneRecordings: [], idleConfig: { mode: 'clock' },
} as SidekickSummary);

const ttsState: TextToSpeechState = {
  status: 'running', installed: true, running: true,
  config: {
    autoStart: true, maxTextCharacters: 1000, maxConcurrentJobs: 1,
    enabledVoices: ['voice-a', 'voice-b', 'voice-c'], defaultModel: 'model-a', defaultVoice: 'voice-a',
  },
  models: [
    { id: 'model-a', label: 'Model A', installed: true },
    { id: 'model-b', label: 'Model B', installed: true },
    { id: 'model-off', label: 'Not installed', installed: false },
  ],
  voices: [
    { id: 'voice-a', model: 'model-a', label: 'Voice A', language: 'English', locale: 'en-US', installed: true, enabled: true },
    { id: 'voice-disabled', model: 'model-a', label: 'Disabled', language: 'English', installed: true, enabled: false },
    { id: 'voice-missing', model: 'model-a', label: 'Missing', language: 'English', installed: false, enabled: true },
    { id: 'voice-b', model: 'model-b', label: 'Voice B', language: 'Spanish', locale: 'es-CL', installed: true, enabled: true },
    { id: 'voice-c', model: 'model-b', label: 'Voice C', language: 'Neutral', installed: true, enabled: true },
  ],
  queue: [],
};

const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
  await user.click(screen.getByLabelText(label));
  await user.click(screen.getByRole('option', { name: option }));
};

const message = (id: string, overrides: Partial<PersonalAgentMessage> = {}): PersonalAgentMessage => ({
  id, agentId: 'agent-1', conversationId: 'conversation-1', role: 'assistant', kind: 'message',
  authorType: 'agent', source: 'human', content: `Message ${id}`, createdAt: '2026-08-10T10:00:00.000Z',
  ...overrides,
});

const conversation = (messages: PersonalAgentMessage[] = []): PersonalAgentConversation => ({
  id: 'conversation-1', agentId: 'agent-1', title: 'Morning conversation', status: 'active',
  origin: 'sidekick', readOnly: true, createdAt: '2026-08-10T09:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z', messages,
});

describe('SidekickVoiceSettings', () => {
  it('uses installed runtime defaults and saves model, voice, TTL, and every STT mode', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <SidekickVoiceSettings
        sidekick={sidekick({ conversationTtlMinutes: 30, sttLanguageMode: 'voice' })}
        copy={copy} ttsState={ttsState} busy={false} onSave={onSave}
      />,
    );
    expect(screen.queryByText(copy.voiceUnavailable)).not.toBeInTheDocument();
    expect(screen.getByLabelText(copy.voiceModelLabel)).toHaveTextContent('Model A');
    expect(screen.getByLabelText(copy.voiceVoiceLabel)).toHaveTextContent('Voice A · English');
    expect(screen.getByLabelText(copy.voiceLocaleLabel)).toHaveValue('English · en-US');
    expect(screen.queryByText('Not installed')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.voiceSettingsSave })).toBeDisabled();

    await choose(user, copy.voiceModelLabel, 'Model B');
    await choose(user, copy.voiceVoiceLabel, 'Voice C · Neutral');
    await choose(user, copy.voiceTtlLabel, copy.voiceTtlOption(180));
    await choose(user, copy.sttLanguageLabel, copy.sttLanguageAuto);
    await user.click(screen.getByRole('button', { name: copy.voiceSettingsSave }));
    expect(onSave).toHaveBeenLastCalledWith('sidekick-1', {
      model: 'model-b', voice: 'voice-c', locale: undefined,
      sttLanguageMode: 'auto', conversationTtlMinutes: 180,
    });

    await choose(user, copy.sttLanguageLabel, copy.sttLanguageSpanglish);
    await user.click(screen.getByRole('button', { name: copy.voiceSettingsSave }));
    expect(onSave).toHaveBeenLastCalledWith('sidekick-1', expect.objectContaining({
      sttLanguageMode: 'subset', sttLanguages: ['es', 'en'],
    }));
    await choose(user, copy.sttLanguageLabel, 'French');
    await user.click(screen.getByRole('button', { name: copy.voiceSettingsSave }));
    expect(onSave).toHaveBeenLastCalledWith('sidekick-1', expect.objectContaining({
      sttLanguageMode: 'fixed', sttLanguages: ['fr'],
    }));
    await choose(user, copy.sttLanguageLabel, copy.sttLanguageVoice);
    await user.click(screen.getByRole('button', { name: copy.voiceSettingsSave }));
    expect(onSave).toHaveBeenLastCalledWith('sidekick-1', expect.objectContaining({ sttLanguageMode: 'voice' }));
  });

  it('preserves valid remote choices, resets when the sidekick changes, and disables incomplete runtimes', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <SidekickVoiceSettings
        sidekick={sidekick({
          model: 'model-b', voice: 'voice-b', locale: 'custom-locale', conversationTtlMinutes: 60,
          sttLanguageMode: 'fixed', sttLanguages: ['es'],
        })}
        copy={copy} ttsState={ttsState} busy onSave={onSave}
      />,
    );
    expect(screen.getByLabelText(copy.voiceModelLabel)).toHaveTextContent('Model B');
    expect(screen.getByLabelText(copy.voiceVoiceLabel)).toHaveTextContent('Voice B · Spanish');
    expect(screen.getByRole('button', { name: copy.voiceSettingsSave })).toBeDisabled();

    const noChoices = { ...ttsState, models: [], voices: [], installed: false };
    rerender(
      <SidekickVoiceSettings
        sidekick={{ ...sidekick({ conversationTtlMinutes: 15, sttLanguageMode: 'subset' }), sidekickId: 'sidekick-2' }}
        copy={copy} ttsState={noChoices} busy={false} onSave={onSave}
      />,
    );
    expect(screen.getByText(copy.voiceUnavailable)).toBeVisible();
    expect(screen.getByLabelText(copy.voiceLocaleLabel)).toHaveValue(copy.voiceLocaleAutomatic);
    expect(screen.getByRole('button', { name: copy.voiceSettingsSave })).toBeDisabled();
    rerender(
      <SidekickVoiceSettings
        sidekick={sidekick({ conversationTtlMinutes: 15, sttLanguageMode: 'auto' })}
        copy={copy} ttsState={null} busy={false} onSave={onSave}
      />,
    );
    expect(screen.getByText(copy.voiceUnavailable)).toBeVisible();
  });

  it('falls back to language codes when Intl has no display name for a language', async () => {
    const user = userEvent.setup();
    const original = Intl.DisplayNames;
    Object.defineProperty(Intl, 'DisplayNames', {
      configurable: true,
      value: class { of() { return undefined; } },
    });
    try {
      render(
        <SidekickVoiceSettings
          sidekick={sidekick({ conversationTtlMinutes: 30, sttLanguageMode: 'auto' })}
          copy={copy} ttsState={ttsState} busy={false} onSave={vi.fn()}
        />,
      );
      await user.click(screen.getByLabelText(copy.sttLanguageLabel));
      expect(screen.getByRole('option', { name: 'fr' })).toBeVisible();
    } finally {
      Object.defineProperty(Intl, 'DisplayNames', { configurable: true, value: original });
    }
  });

  it('falls back to language codes when Intl display names are unavailable', async () => {
    const user = userEvent.setup();
    const original = Intl.DisplayNames;
    Object.defineProperty(Intl, 'DisplayNames', {
      configurable: true,
      value: class { constructor() { throw new Error('unsupported'); } },
    });
    try {
      render(
        <SidekickVoiceSettings
          sidekick={sidekick({ conversationTtlMinutes: 30, sttLanguageMode: 'auto' })}
          copy={copy} ttsState={ttsState} busy={false} onSave={vi.fn()}
        />,
      );
      await user.click(screen.getByLabelText(copy.sttLanguageLabel));
      expect(screen.getByRole('option', { name: 'fr' })).toBeVisible();
    } finally {
      Object.defineProperty(Intl, 'DisplayNames', { configurable: true, value: original });
    }
  });
});

describe('Sidekick conversations', () => {
  it('renders loading, empty, and openable conversation rows', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const item = conversation();
    const { rerender } = render(
      <SidekickConversationList copy={copy} conversations={[item]} loading onOpen={onOpen} />,
    );
    expect(screen.getByText(copy.conversationsLoading)).toBeVisible();
    expect(screen.getByText(item.title)).toBeVisible();
    rerender(<SidekickConversationList copy={copy} conversations={[]} loading={false} onOpen={onOpen} />);
    expect(screen.getByText(copy.conversationsEmpty)).toBeVisible();
    rerender(<SidekickConversationList copy={copy} conversations={[item]} loading={false} onOpen={onOpen} />);
    await user.click(screen.getByRole('button', { name: copy.conversationOpen }));
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it('filters private progress and renders user, agent, spoken, reasoning, and empty dialogs', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const messages = [
      message('system', { role: 'system', authorType: 'system' }),
      message('intermediate', { kind: 'intermediate' }),
      message('user', { role: 'user', authorType: 'user', content: 'Person message' }),
      message('agent', { content: 'Agent **answer**', reasoning: 'Checked **facts**' }),
      message('spoken', { kind: 'spoken', content: 'Spoken answer' }),
    ];
    const { rerender } = render(
      <SidekickConversationDialog copy={copy} conversation={null} onClose={onClose} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    rerender(<SidekickConversationDialog copy={copy} conversation={conversation([])} onClose={onClose} />);
    expect(screen.getByText(copy.conversationNoMessages)).toBeVisible();
    rerender(<SidekickConversationDialog copy={copy} conversation={conversation(messages)} onClose={onClose} />);
    expect(screen.queryByText('Message system')).not.toBeInTheDocument();
    expect(screen.queryByText('Message intermediate')).not.toBeInTheDocument();
    expect(screen.getByText('Person message')).toBeVisible();
    expect(screen.getByText((_content, element) => (
      element?.tagName === 'P' && element.textContent === 'Agent answer'
    ))).toBeVisible();
    expect(screen.getByText('Spoken answer')).toBeVisible();
    await user.click(screen.getByText(copy.conversationReasoning));
    expect(screen.getByText((_content, element) => (
      element?.tagName === 'P' && element.textContent === 'Checked facts'
    ))).toBeVisible();
    await user.click(screen.getByRole('button', { name: copy.configClose }));
    expect(onClose).toHaveBeenCalledOnce();
    const dialog = screen.getByRole('dialog');
    rerender(<SidekickConversationDialog copy={copy} conversation={null} onClose={onClose} />);
    await waitForElementToBeRemoved(dialog);
  });
});
