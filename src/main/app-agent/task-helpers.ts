import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AppCodexTaskAttachment,
  AppCodexTaskFileArgument,
  AppPromptTemplate,
  AppPromptTemplateArgument,
} from '../../shared/types';
import { renderPromptFile } from '../prompt-builder';

export interface PreparedFileArgument {
  argumentName: string;
  name: string;
  path: string;
  mimeType?: string;
}

export interface PreparedPromptArguments {
  variables: Record<string, string | number | boolean | null>;
  files: PreparedFileArgument[];
}

export type TaskLocale = 'es' | 'en';

type TaskMessageKey =
  | 'preparing'
  | 'working'
  | 'completed'
  | 'finished'
  | 'technicalLimit'
  | 'reviewingCategories'
  | 'loadingMovements'
  | 'validatingData'
  | 'confirmingMovements'
  | 'readingDocument'
  | 'reviewingInstructions'
  | 'usingTools';

export const normalizeTaskLocale = (value: unknown): TaskLocale => {
  const normalized = typeof value === 'string' ? value.toLowerCase() : '';
  return normalized === 'en' || normalized.startsWith('en-') ? 'en' : 'es';
};

const taskMessages: Record<TaskLocale, Record<TaskMessageKey, string>> = {
  es: {
    preparing: 'El asistente está preparando el análisis.',
    working: 'El asistente está trabajando en el documento.',
    completed: 'El asistente completó la tarea.',
    finished: 'El asistente terminó la tarea.',
    technicalLimit: 'El asistente encontró una limitación técnica y está probando otra estrategia.',
    reviewingCategories: 'Revisando categorías disponibles para clasificar.',
    loadingMovements: 'Cargando movimientos en la base local.',
    validatingData: 'Validando que los datos queden consistentes.',
    confirmingMovements: 'Confirmando los movimientos cargados.',
    readingDocument: 'Leyendo el contenido del documento.',
    reviewingInstructions: 'Revisando las instrucciones internas de Finance OS.',
    usingTools: 'Usando herramientas internas de Finance OS.',
  },
  en: {
    preparing: 'The assistant is preparing the analysis.',
    working: 'The assistant is working on the document.',
    completed: 'The assistant completed the task.',
    finished: 'The assistant finished the task.',
    technicalLimit: 'The assistant found a technical limitation and is trying another approach.',
    reviewingCategories: 'Reviewing available categories for classification.',
    loadingMovements: 'Loading movements into the local database.',
    validatingData: 'Validating that the data is consistent.',
    confirmingMovements: 'Confirming the loaded movements.',
    readingDocument: 'Reading the document contents.',
    reviewingInstructions: 'Reviewing the internal Finance OS instructions.',
    usingTools: 'Using internal Finance OS tools.',
  },
};

export const taskMessage = (locale: TaskLocale, key: TaskMessageKey): string =>
  taskMessages[locale][key];

const taskLocaleName = (locale: TaskLocale): string =>
  locale === 'en' ? 'English' : 'Spanish';

const escapePromptTemplateMarkers = (value: string): string =>
  value.replaceAll('{{', '{ {').replaceAll('}}', '} }');

export const sanitizeFilename = (value: string): string =>
  sanitizeDotFilename(value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 160));

const sanitizeDotFilename = (value: string): string => {
  const sanitized = value.trim() || 'attachment';
  return sanitized === '.' || sanitized === '..' ? 'attachment' : sanitized;
};

export const uniqueFilename = (safeName: string, usedNames: Set<string>): string => {
  if (!usedNames.has(safeName)) {
    usedNames.add(safeName);
    return safeName;
  }
  const parsed = path.parse(safeName);
  for (let index = 2; ; index += 1) {
    const candidate = `${parsed.name}-${index}${parsed.ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
};

const normalizeMimeType = (value: string | undefined): string =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const isCodexFileArgument = (value: unknown): value is AppCodexTaskFileArgument =>
  Boolean(
    value
      && typeof value === 'object'
      && (value as AppCodexTaskFileArgument).type === 'file'
      && typeof (value as AppCodexTaskFileArgument).dataBase64 === 'string',
  );

export const validateAttachmentType = (
  template: AppPromptTemplate,
  attachment: AppCodexTaskAttachment,
  safeName: string,
): void => {
  const accepted = template.acceptedFileTypes?.map((entry) => entry.trim().toLowerCase()).filter(Boolean) ?? [];
  if (accepted.length === 0) {
    return;
  }

  const mimeType = normalizeMimeType(attachment.mimeType);
  const fileName = safeName.toLowerCase();
  const matchesAcceptedType = accepted.some((entry) => {
    if (entry.endsWith('/*')) {
      return mimeType.startsWith(entry.slice(0, -1));
    }
    if (entry.startsWith('.')) {
      return fileName.endsWith(entry);
    }
    return mimeType === entry;
  });

  if (!matchesAcceptedType) {
    throw new Error('attachment_type_not_accepted');
  }
};

export const validateFileArgumentType = (
  argument: AppPromptTemplateArgument,
  file: AppCodexTaskFileArgument,
  safeName: string,
): void => {
  const accepted = argument.acceptedFileTypes?.map((entry) => entry.trim().toLowerCase()).filter(Boolean) ?? [];
  if (accepted.length === 0) {
    return;
  }

  const mimeType = normalizeMimeType(file.mimeType);
  const fileName = safeName.toLowerCase();
  const matchesAcceptedType = accepted.some((entry) => {
    if (entry.endsWith('/*')) {
      return mimeType.startsWith(entry.slice(0, -1));
    }
    if (entry.startsWith('.')) {
      return fileName.endsWith(entry);
    }
    return mimeType === entry;
  });

  if (!matchesAcceptedType) {
    throw new Error(`app_prompt_file_type_not_accepted:${argument.name}`);
  }
};

export const normalizeStringArgument = (argument: AppPromptTemplateArgument, value: unknown): string => {
  const text =
    value && typeof value === 'object' && (value as { type?: unknown }).type === 'string'
      ? (value as { value?: unknown }).value
      : value;
  if (typeof text !== 'string' && typeof text !== 'number' && typeof text !== 'boolean') {
    throw new Error(`app_prompt_argument_invalid:${argument.name}`);
  }
  const normalized = String(text);
  if (argument.maxLength && normalized.length > argument.maxLength) {
    throw new Error(`app_prompt_string_too_long:${argument.name}`);
  }
  return normalized;
};

export const normalizeFileArgumentValue = (
  argument: AppPromptTemplateArgument,
  value: unknown,
): AppCodexTaskFileArgument[] => {
  const values = Array.isArray(value) ? value : [value];
  if (!argument.multiple && values.length > 1) {
    throw new Error(`app_prompt_argument_multiple_not_allowed:${argument.name}`);
  }
  if (!values.every(isCodexFileArgument)) {
    throw new Error(`app_prompt_argument_invalid:${argument.name}`);
  }
  return values;
};

export const buildLegacyPromptVariables = (
  variables: Record<string, string | number | boolean | null>,
  files: PreparedFileArgument[],
): Record<string, string | number | boolean | null> => {
  if (files.length !== 1) {
    return variables;
  }
  return {
    ...variables,
    filename: files[0].path,
  };
};

export const formatFileArgumentForPrompt = (files: PreparedFileArgument[]): string => {
  if (files.length === 0) {
    return '';
  }
  if (files.length === 1) {
    return files[0].path;
  }
  return files.map((file) => `- ${file.name}: ${file.path}`).join('\n');
};

export const renderPrompt = (
  template: string,
  preparedArguments: PreparedPromptArguments,
  locale: TaskLocale = 'es',
): string => {
  let rendered = template;
  for (const [key, value] of Object.entries(preparedArguments.variables)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value == null ? '' : escapePromptTemplateMarkers(String(value)));
  }
  const fileLines = preparedArguments.files.length
    ? preparedArguments.files.map((file) => {
        const mimeType = file.mimeType ? ` (${file.mimeType})` : '';
        return escapePromptTemplateMarkers(`- ${file.argumentName}.${file.name}: ${file.path}${mimeType}`);
      })
    : [locale === 'en' ? '- No files were provided.' : '- No se adjuntaron archivos.'];
  return renderPromptFile('tasks/task-wrapper.md', {
    taskInstructions: rendered.trim(),
    fileLines: fileLines.join('\n'),
    localeName: taskLocaleName(locale),
  });
};

export const appendTranscript = async (
  transcriptPath: string,
  stream: 'stdout' | 'stderr' | 'meta',
  text: string,
): Promise<void> => {
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  await fs.appendFile(transcriptPath, `[${new Date().toISOString()}] [${stream}] ${text}\n`, 'utf8');
};

export const isStaleCodexThreadError = (text: string): boolean =>
  /failed to record rollout items:\s*thread\s+.+\s+not found/i.test(text);

export const progressFromCodexOutput = (text: string, locale: TaskLocale): string | null => {
  for (const line of text.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === 'turn.started') {
        return taskMessage(locale, 'working');
      }
      if (parsed.type === 'item.completed' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (item.type === 'command_execution') {
          return progressFromCommandExecution(item, locale);
        }
        if (item.type === 'agent_message') {
          return progressFromAgentMessage(item);
        }
      }
      if (parsed.type === 'item.started' && parsed.item && typeof parsed.item === 'object') {
        const item = parsed.item as Record<string, unknown>;
        if (String(item.type ?? '').includes('tool')) {
          return taskMessage(locale, 'usingTools');
        }
        if (item.type === 'command_execution') {
          return progressFromCommandExecution(item, locale);
        }
      }
    } catch {
      continue;
    }
  }
  return null;
};

const progressFromAgentMessage = (item: Record<string, unknown>): string | null => {
  if (typeof item.text !== 'string') {
    return null;
  }
  const firstSentence = stripMarkdown(item.text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)[0]
    .trim();
  if (!firstSentence) {
    return null;
  }
  return firstSentence.length > 140 ? `${firstSentence.slice(0, 137)}...` : firstSentence;
};

const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[\s*-]*[-*+]\s+/gm, '')
    .replace(/^[\s\d.]+[.)]\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .trim();

const progressFromCommandExecution = (item: Record<string, unknown>, locale: TaskLocale): string | null => {
  const command = typeof item.command === 'string' ? item.command : '';
  const status = typeof item.status === 'string' ? item.status : '';
  const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
  if (status === 'failed' || (exitCode !== null && exitCode !== 0)) {
    return taskMessage(locale, 'technicalLimit');
  }
  if (command.includes('list_categories.py')) {
    return taskMessage(locale, 'reviewingCategories');
  }
  if (command.includes('import_movements.py')) {
    return taskMessage(locale, 'loadingMovements');
  }
  if (command.includes('verify_data_integrity.py') || command.includes('scripts/verify.py')) {
    return taskMessage(locale, 'validatingData');
  }
  if (command.includes('list_movements.py')) {
    return taskMessage(locale, 'confirmingMovements');
  }
  if (command.includes('pdftotext') || command.includes('PdfReader') || command.includes('.pdf')) {
    return taskMessage(locale, 'readingDocument');
  }
  if (command.includes('skills/load-movements') || command.includes('AGENTS.md')) {
    return taskMessage(locale, 'reviewingInstructions');
  }
  if (command) {
    return taskMessage(locale, 'usingTools');
  }
  return null;
};
