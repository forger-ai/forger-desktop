import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogApp, SubmitProductFeedbackInput } from '@shared/types';
import { getDictionary } from '@renderer/i18n';
import { FeedbackView } from '@renderer/views/FeedbackView';

const t = getDictionary('en');

const app = (overrides: Partial<CatalogApp>): CatalogApp => ({
  id: 'app-default',
  category: 'productivity',
  status: 'not_installed',
  ...overrides,
});

const apps: CatalogApp[] = [
  app({ id: 'installed', name: 'Installed App', status: 'installed', version: '1.0.0' }),
  app({ id: 'beta', name: 'Beta App', catalogStatus: 'beta', version: '0.8.0' }),
  app({ id: 'production', name: 'Production App', catalogStatus: 'production', latestVersion: '2.0.0', version: '1.0.0' }),
  app({ id: 'coming', name: 'Coming App', catalogStatus: 'coming' }),
  app({ id: 'unnamed', status: 'installed' }),
  app({ id: 'draft', name: 'Hidden Draft', catalogStatus: 'draft' }),
  app({ id: 'private', name: 'Hidden Private' }),
];

const choose = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
  await user.click(screen.getByRole('combobox', { name: label }));
  await user.click(screen.getByRole('option', { name: option }));
};

const renderFeedback = (
  onSubmitFeedback = vi.fn<(input: SubmitProductFeedbackInput) => Promise<{ success: boolean }>>()
    .mockResolvedValue({ success: true }),
  appList = apps,
) => {
  render(
    <FeedbackView
      apps={appList}
      t={t}
      desktopVersion="0.5.16"
      onSubmitFeedback={onSubmitFeedback}
    />,
  );
  return onSubmitFeedback;
};

describe('FeedbackView', () => {
  it('submits trimmed Forger feedback with environment details and reports success', async () => {
    const user = userEvent.setup();
    const onSubmit = renderFeedback();
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');

    const body = screen.getByRole('textbox', { name: t.sections.feedback.bodyLabel });
    const send = screen.getByRole('button', { name: t.sections.feedback.send });
    expect(send).toBeDisabled();

    await user.type(body, '  The onboarding needs clearer copy.  ');
    await choose(user, t.sections.feedback.kindLabel, t.sections.feedback.kinds.confusing);
    await user.click(send);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith({
      target: 'forger',
      appId: undefined,
      kind: 'confusing',
      body: 'The onboarding needs clearer copy.',
      surface: 'feedback',
      platform: 'MacIntel',
      desktopVersion: '0.5.16',
      appVersionLabel: undefined,
    });
    expect(await screen.findByText(t.sections.feedback.sent)).toBeVisible();
    expect(body).toHaveValue('');
  });

  it('offers only installed or published apps and reports their preferred version', async () => {
    const user = userEvent.setup();
    const onSubmit = renderFeedback();

    await choose(user, t.sections.feedback.targetLabel, t.sections.feedback.targets.app);
    await choose(user, t.sections.feedback.appLabel, 'Production App');
    await choose(user, t.sections.feedback.kindLabel, t.sections.feedback.kinds.featureRequest);
    await user.type(screen.getByRole('textbox', { name: t.sections.feedback.bodyLabel }), 'Add scheduled exports');
    await user.click(screen.getByRole('button', { name: t.sections.feedback.send }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      target: 'app',
      appId: 'production',
      kind: 'feature_request',
      appVersionLabel: '2.0.0',
    })));

    await choose(user, t.sections.feedback.appLabel, 'Beta App');
    await user.type(screen.getByRole('textbox', { name: t.sections.feedback.bodyLabel }), 'Second report');
    await user.click(screen.getByRole('button', { name: t.sections.feedback.send }));
    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
      appId: 'beta',
      appVersionLabel: '0.8.0',
    })));

    await user.click(screen.getByRole('combobox', { name: t.sections.feedback.appLabel }));
    expect(screen.getByRole('option', { name: 'Installed App' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Beta App' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Production App' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Coming App' })).toBeVisible();
    expect(screen.getByRole('option', { name: 'unnamed' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Hidden Draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Hidden Private' })).not.toBeInTheDocument();
  });

  it('keeps a failed submission editable and blocks duplicate clicks while pending', async () => {
    const user = userEvent.setup();
    let resolveSubmission!: (value: { success: boolean }) => void;
    const pending = new Promise<{ success: boolean }>((resolve) => {
      resolveSubmission = resolve;
    });
    const onSubmit = vi.fn<(input: SubmitProductFeedbackInput) => Promise<{ success: boolean }>>()
      .mockReturnValue(pending);
    renderFeedback(onSubmit);

    const body = screen.getByRole('textbox', { name: t.sections.feedback.bodyLabel });
    await user.type(body, 'Something went wrong');
    await choose(user, t.sections.feedback.kindLabel, t.sections.feedback.kinds.error);
    await user.click(screen.getByRole('button', { name: t.sections.feedback.send }));

    expect(screen.getByRole('button', { name: t.sections.feedback.sending })).toBeDisabled();
    expect(onSubmit).toHaveBeenCalledOnce();
    resolveSubmission({ success: false });

    await waitFor(() => expect(screen.getByRole('button', { name: t.sections.feedback.send })).toBeEnabled());
    expect(body).toHaveValue('Something went wrong');
    expect(screen.queryByText(t.sections.feedback.sent)).not.toBeInTheDocument();
  });

  it('clears the success message when any form selection or the body changes', async () => {
    const user = userEvent.setup();
    renderFeedback();
    const body = screen.getByRole('textbox', { name: t.sections.feedback.bodyLabel });

    await user.type(body, 'Initial feedback');
    await user.click(screen.getByRole('button', { name: t.sections.feedback.send }));
    expect(await screen.findByText(t.sections.feedback.sent)).toBeVisible();

    await user.type(body, 'Changed');
    expect(screen.queryByText(t.sections.feedback.sent)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.sections.feedback.send }));
    expect(await screen.findByText(t.sections.feedback.sent)).toBeVisible();

    await choose(user, t.sections.feedback.kindLabel, t.sections.feedback.kinds.wouldUseIf);
    expect(screen.queryByText(t.sections.feedback.sent)).not.toBeInTheDocument();
    await user.type(body, 'Use with calendar');
    await user.click(screen.getByRole('button', { name: t.sections.feedback.send }));
    expect(await screen.findByText(t.sections.feedback.sent)).toBeVisible();

    await choose(user, t.sections.feedback.targetLabel, t.sections.feedback.targets.app);
    expect(screen.queryByText(t.sections.feedback.sent)).not.toBeInTheDocument();
    await user.type(body, 'App feedback');
    await user.click(screen.getByRole('button', { name: t.sections.feedback.send }));
    expect(await screen.findByText(t.sections.feedback.sent)).toBeVisible();

    await choose(user, t.sections.feedback.appLabel, 'Coming App');
    expect(screen.queryByText(t.sections.feedback.sent)).not.toBeInTheDocument();
  });

  it('requires an available app when the specific-app target is selected', async () => {
    const user = userEvent.setup();
    renderFeedback(undefined, [app({ id: 'hidden', catalogStatus: 'draft' })]);

    await choose(user, t.sections.feedback.targetLabel, t.sections.feedback.targets.app);
    await user.type(screen.getByRole('textbox', { name: t.sections.feedback.bodyLabel }), 'Cannot choose an app');
    expect(screen.getByRole('button', { name: t.sections.feedback.send })).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: t.sections.feedback.appLabel }));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it.each([
    ['I would not use it because', t.sections.feedback.kinds.wouldNotUseBecause, 'would_not_use_because'],
    ['Other feedback', t.sections.feedback.kinds.other, 'other'],
  ] as const)('submits the %s category', async (_label, option, expectedKind) => {
    const user = userEvent.setup();
    const onSubmit = renderFeedback();
    await user.type(screen.getByRole('textbox', { name: t.sections.feedback.bodyLabel }), 'Category coverage');
    if (expectedKind !== 'other') {
      await choose(user, t.sections.feedback.kindLabel, option);
    }
    await user.click(screen.getByRole('button', { name: t.sections.feedback.send }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ kind: expectedKind })));
  });
});
