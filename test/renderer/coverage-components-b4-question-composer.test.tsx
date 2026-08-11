import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QuestionComposer, type QuestionAction } from '@renderer/views/chat/QuestionComposer';
import { en } from '@renderer/i18n/en';
import type { AppDictionary } from '@renderer/i18n';

const t = en as unknown as AppDictionary;
const action: QuestionAction = {
  type: 'question',
  runId: 'run-1',
  status: 'pending',
  request: {
    requestId: 'request-1',
    chatId: 'chat-1',
    createdAt: '2026-08-10T10:00:00.000Z',
    questions: [
      {
        id: 'audience',
        question: 'Who is the audience?',
        options: [
          { id: 'team', label: 'My team', description: 'People in the company' },
          { id: 'customers', label: 'Customers', description: 'External customers' },
        ],
      },
      {
        id: 'tone',
        question: 'Which tone should it use?',
        options: [
          { id: 'friendly', label: 'Friendly', description: '' },
          { id: 'formal', label: 'Formal', description: 'More formal language' },
        ],
      },
    ],
  },
};

describe('QuestionComposer', () => {
  it('collects free text and an option across questions, supports back, and submits structured answers', async () => {
    const user = userEvent.setup();
    const onRespondQuestion = vi.fn();
    render(<QuestionComposer action={action} isResponding={false} t={t} onRespondQuestion={onRespondQuestion} />);

    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t.sections.chat.questionPrevious })).toBeDisabled();
    const next = screen.getByRole('button', { name: t.sections.chat.questionNext });
    expect(next).toBeDisabled();

    const freeText = screen.getByPlaceholderText(t.sections.chat.questionFreeTextPlaceholder);
    await user.type(freeText, '  Product leaders  ');
    expect(next).toBeEnabled();
    await user.click(next);

    expect(screen.getByText('2/2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.sections.chat.questionPrevious }));
    expect(screen.getByText('1/2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t.sections.chat.questionNext }));

    await user.click(screen.getByRole('button', { name: /Friendly/ }));
    const submit = screen.getByRole('button', { name: t.sections.chat.questionSubmit });
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(onRespondQuestion).toHaveBeenCalledWith('run-1', action.request, {
      answers: [
        {
          questionId: 'audience',
          question: 'Who is the audience?',
          optionId: '__free_text__',
          label: 'Product leaders',
        },
        {
          questionId: 'tone',
          question: 'Which tone should it use?',
          optionId: 'friendly',
          label: 'Friendly',
        },
      ],
    });
  });

  it('preserves option mode for blank text and preserves typed text when an option is selected', async () => {
    const user = userEvent.setup();
    render(<QuestionComposer action={action} isResponding={false} t={t} onRespondQuestion={vi.fn()} />);
    const freeText = screen.getByPlaceholderText(t.sections.chat.questionFreeTextPlaceholder);

    await user.type(freeText, 'Draft detail');
    await user.click(screen.getByRole('button', { name: /My team/ }));
    await user.clear(freeText);
    await user.type(freeText, '   ');
    expect(screen.getByRole('button', { name: t.sections.chat.questionNext })).toBeEnabled();

    await user.click(screen.getByLabelText('External customers'));
    expect(screen.getByRole('button', { name: t.sections.chat.questionNext })).toBeEnabled();
  });

  it('includes an option description in the submitted answer when one is provided', async () => {
    const user = userEvent.setup();
    const onRespondQuestion = vi.fn();
    const singleQuestionAction: QuestionAction = {
      ...action,
      request: { ...action.request, questions: [action.request.questions[0]] },
    };
    render(
      <QuestionComposer
        action={singleQuestionAction}
        isResponding={false}
        t={t}
        onRespondQuestion={onRespondQuestion}
      />,
    );

    await user.click(screen.getByRole('button', { name: /My team/ }));
    await user.click(screen.getByRole('button', { name: t.sections.chat.questionSubmit }));

    expect(onRespondQuestion).toHaveBeenCalledWith('run-1', singleQuestionAction.request, {
      answers: [{
        questionId: 'audience',
        question: 'Who is the audience?',
        optionId: 'team',
        label: 'My team',
        description: 'People in the company',
      }],
    });
  });

  it('locks every answer and navigation control while responding', () => {
    render(<QuestionComposer action={action} isResponding t={t} onRespondQuestion={vi.fn()} />);

    expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByPlaceholderText(t.sections.chat.questionFreeTextPlaceholder)).toBeDisabled();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });
});
