import { Button, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import { useState } from 'react';
import type { AppDictionary } from '@renderer/i18n';
import type { ChatMessage, ChatQuestionResponse } from '../ChatView';
import type { ChatQuestionRequest } from '@shared/types';

export type QuestionAction = Extract<NonNullable<ChatMessage['action']>, { type: 'question' }>;

interface QuestionDraftAnswer {
  mode: 'options' | 'freeText' | null;
  optionId?: string;
  freeText: string;
}

interface QuestionComposerProps {
  action: QuestionAction;
  isResponding: boolean;
  t: AppDictionary;
  onRespondQuestion: (runId: string, request: ChatQuestionRequest, response: ChatQuestionResponse) => void;
}

export function QuestionComposer({
  action,
  isResponding,
  t,
  onRespondQuestion,
}: QuestionComposerProps) {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answersByQuestionId, setAnswersByQuestionId] = useState<Record<string, QuestionDraftAnswer>>({});
  const questions = action.request.questions;
  const currentQuestion = questions[Math.min(currentQuestionIndex, questions.length - 1)];
  const currentAnswer = answersByQuestionId[currentQuestion.id] ?? { mode: null, freeText: '' };
  const currentFreeText = currentAnswer.freeText;
  const hasCurrentFreeText = currentFreeText.trim().length > 0;
  const canAdvance = !isResponding && (
    (currentAnswer.mode === 'options' && Boolean(currentAnswer.optionId))
    || (currentAnswer.mode === 'freeText' && hasCurrentFreeText)
  );
  const isLastQuestion = currentQuestionIndex === questions.length - 1;

  const selectOption = (questionId: string, optionId: string) => {
    setAnswersByQuestionId((current) => ({
      ...current,
      [questionId]: {
        mode: 'options',
        optionId,
        freeText: current[questionId]?.freeText ?? '',
      },
    }));
  };

  const updateFreeText = (questionId: string, value: string) => {
    setAnswersByQuestionId((current) => ({
      ...current,
      [questionId]: {
        mode: value.trim() ? 'freeText' : current[questionId]?.mode ?? null,
        optionId: value.trim() ? undefined : current[questionId]?.optionId,
        freeText: value,
      },
    }));
  };

  const buildAnswers = () => questions.flatMap((question) => {
    const answer = answersByQuestionId[question.id];
    if (!answer) {
      return [];
    }
    if (answer.mode === 'freeText' && answer.freeText.trim()) {
      return [{
        questionId: question.id,
        question: question.question,
        optionId: '__free_text__',
        label: answer.freeText.trim(),
      }];
    }
    const selectedOption = question.options.find((option) => option.id === answer.optionId);
    return selectedOption ? [{
      questionId: question.id,
      question: question.question,
      optionId: selectedOption.id,
      label: selectedOption.label,
      ...(selectedOption.description ? { description: selectedOption.description } : {}),
    }] : [];
  });

  const advance = () => {
    if (!canAdvance) {
      return;
    }
    if (!isLastQuestion) {
      setCurrentQuestionIndex((current) => current + 1);
      return;
    }
    onRespondQuestion(action.runId, action.request, {
      answers: buildAnswers(),
    });
  };

  return (
    <Stack spacing={1.25} sx={{ minHeight: 92, px: 0.4, py: 0.25 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1}>
        <Typography variant="caption" color="text.secondary">
          {currentQuestionIndex + 1}/{questions.length}
        </Typography>
      </Stack>
      <Stack spacing={0.75}>
        <Typography variant="body2" fontWeight={700} sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          {currentQuestion.question}
        </Typography>
        <Stack spacing={0.75}>
          {currentQuestion.options.map((option) => {
            const selected = currentAnswer.mode === 'options' && currentAnswer.optionId === option.id;
            return (
              <Button
                key={option.id}
                fullWidth
                variant={selected ? 'contained' : 'outlined'}
                size="small"
                disabled={isResponding}
                onClick={() => selectOption(currentQuestion.id, option.id)}
                sx={{ justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}
              >
                {option.label}
              </Button>
            );
          })}
        </Stack>
      </Stack>
      <TextField
        size="small"
        multiline
        minRows={2}
        maxRows={4}
        value={currentFreeText}
        onChange={(event) => updateFreeText(currentQuestion.id, event.target.value)}
        disabled={isResponding}
        placeholder={t.sections.chat.questionFreeTextPlaceholder}
      />
      <Button
        variant="contained"
        size="small"
        disabled={!canAdvance}
        startIcon={isResponding ? <CircularProgress size={14} color="inherit" /> : undefined}
        onClick={advance}
        sx={{ alignSelf: 'flex-start' }}
      >
        {isLastQuestion ? t.sections.chat.questionSubmit : t.sections.chat.questionNext}
      </Button>
    </Stack>
  );
}
