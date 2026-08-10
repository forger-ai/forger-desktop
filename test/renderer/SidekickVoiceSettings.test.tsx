import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SidekickVoiceSettings } from '@renderer/views/sidekicks/SidekickVoiceExperience';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';
import type { SidekickSummary } from '@shared/types';

const copy = (en as unknown as AppDictionary).sections.sidekicks;

const sidekickWithoutVoiceRuntime = {
  sidekickId: 'desk-sidekick',
  voiceConfig: {
    conversationTtlMinutes: 60,
    sttLanguageMode: 'voice',
  },
} as SidekickSummary;

describe('SidekickVoiceSettings', () => {
  it('stays usable and explains the unavailable state when local speech setup is missing', () => {
    const onSave = vi.fn();

    render(
      <SidekickVoiceSettings
        sidekick={sidekickWithoutVoiceRuntime}
        copy={copy}
        ttsState={null}
        busy={false}
        onSave={onSave}
      />,
    );

    expect(screen.getByText(copy.voiceUnavailable)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: copy.voiceModelLabel })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('combobox', { name: copy.voiceVoiceLabel })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: copy.voiceSettingsSave })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });
});
