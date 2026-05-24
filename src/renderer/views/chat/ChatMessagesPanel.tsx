import { Avatar, Box, Button, Chip, CircularProgress, Paper, Stack, Typography, useTheme } from '@mui/material';
import type { AppDictionary } from '@renderer/i18n';
import type { ChatMessage } from '../ChatView';
import { compactFileName, formatBytes } from '../chat-view-helpers';
import { MarkdownMessage } from './MarkdownMessage';

interface ChatMessagesPanelProps {
  messages: ChatMessage[];
  conversationTitle: string;
  codexConfigured: boolean;
  assistantAvatarSrc: string;
  isSending: boolean;
  progressLines: string[];
  openingAppIds: Set<string>;
  respondingPermissionIds: Set<string>;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  t: AppDictionary;
  onConfigureCodex: () => void;
  onOpenApp: (appId: string) => void;
  onRespondPermission: (runId: string, requestId: string, decision: 'allow' | 'deny') => void;
  onAutoScrollChange: (shouldAutoScroll: boolean) => void;
}

export function ChatMessagesPanel({
  messages,
  conversationTitle,
  codexConfigured,
  assistantAvatarSrc,
  isSending,
  progressLines,
  openingAppIds,
  respondingPermissionIds,
  scrollRef,
  t,
  onConfigureCodex,
  onOpenApp,
  onRespondPermission,
  onAutoScrollChange,
}: ChatMessagesPanelProps) {
  const hasMessages = messages.length > 0;

  return (
    <Box
      ref={scrollRef}
      onScroll={(event) => {
        const target = event.currentTarget;
        const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
        onAutoScrollChange(distanceFromBottom <= 4);
      }}
      sx={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        overflowX: 'hidden',
        overflowY: 'auto',
        py: 1,
      }}
    >
      <Stack spacing={2} sx={{ minWidth: 0 }}>
        {!hasMessages ? (
          <Stack alignItems="center" justifyContent="center" sx={{ pt: 6 }} spacing={1}>
            <Typography variant="h4" textAlign="center">
              {conversationTitle}
            </Typography>
            <Typography color="text.secondary" textAlign="center" sx={{ maxWidth: 480 }}>
              {codexConfigured ? t.sections.chat.introBody : t.sections.chat.codexMissingBody}
            </Typography>
            {!codexConfigured ? (
              <Button variant="contained" onClick={onConfigureCodex}>
                {t.sections.chat.configureCodex}
              </Button>
            ) : null}
          </Stack>
        ) : (
          messages.map((message) => (
            <ChatMessageRow
              key={message.id}
              message={message}
              assistantAvatarSrc={assistantAvatarSrc}
              openingAppIds={openingAppIds}
              respondingPermissionIds={respondingPermissionIds}
              t={t}
              onOpenApp={onOpenApp}
              onRespondPermission={onRespondPermission}
            />
          ))
        )}
        {isSending ? (
          <Stack direction="row" spacing={1.25} alignItems="flex-start" sx={{ minWidth: 0, maxWidth: '100%', overflowX: 'hidden' }}>
            <Avatar
              src={assistantAvatarSrc}
              sx={{
                width: 30,
                height: 30,
                bgcolor: '#fff',
                p: 0.05,
                pb: 0,
                '& img': { objectFit: 'contain' },
              }}
            />
            <Box sx={{ maxWidth: '78%', minWidth: 0, color: 'text.secondary', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <CircularProgress size={14} />
                <Typography variant="caption">{t.sections.chat.codexThinking}</Typography>
              </Stack>
              {progressLines.length > 0 ? (
                <Box component="ul" sx={{ m: 0, pl: 2, minWidth: 0, maxWidth: '100%' }}>
                  {progressLines.slice(-6).map((line, idx) => (
                    <Typography component="li" variant="caption" key={`${idx}-${line}`} sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
                      {line}
                    </Typography>
                  ))}
                </Box>
              ) : null}
            </Box>
          </Stack>
        ) : null}
      </Stack>
    </Box>
  );
}

interface ChatMessageRowProps {
  message: ChatMessage;
  assistantAvatarSrc: string;
  openingAppIds: Set<string>;
  respondingPermissionIds: Set<string>;
  t: AppDictionary;
  onOpenApp: (appId: string) => void;
  onRespondPermission: (runId: string, requestId: string, decision: 'allow' | 'deny') => void;
}

function ChatMessageRow({
  message,
  assistantAvatarSrc,
  openingAppIds,
  respondingPermissionIds,
  t,
  onOpenApp,
  onRespondPermission,
}: ChatMessageRowProps) {
  const theme = useTheme();

  return (
    <Stack
      direction="row"
      spacing={1.25}
      justifyContent={message.role === 'user' ? 'flex-end' : 'flex-start'}
      sx={{ minWidth: 0, maxWidth: '100%', overflowX: 'hidden' }}
    >
      {message.role === 'assistant' ? (
        <Avatar
          src={assistantAvatarSrc}
          sx={{
            width: 30,
            height: 30,
            bgcolor: '#fff',
            p: 0.05,
            pb: 0,
            '& img': { objectFit: 'contain' },
          }}
        />
      ) : null}
      <Box
        sx={{
          maxWidth: message.role === 'user' ? '72%' : '78%',
          minWidth: 0,
          px: message.role === 'user' ? 1.6 : 0,
          py: message.role === 'user' ? 1.2 : 0,
          borderRadius: message.role === 'user' ? 1 : 0,
          bgcolor: message.role === 'user' ? 'primary.main' : 'transparent',
          color:
            message.role === 'user'
              ? theme.palette.primary.contrastText
              : theme.palette.text.primary,
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        }}
      >
        {message.role === 'assistant' ? (
          <Stack spacing={1} sx={{ minWidth: 0 }}>
            <MarkdownMessage content={message.content} />
            {message.action?.type === 'open-app' ? (
              <OpenAppActionButton action={message.action} openingAppIds={openingAppIds} t={t} onOpenApp={onOpenApp} />
            ) : null}
            {message.action?.type === 'permission' ? (
              <PermissionActionCard
                action={message.action}
                respondingPermissionIds={respondingPermissionIds}
                t={t}
                onRespondPermission={onRespondPermission}
              />
            ) : null}
          </Stack>
        ) : (
          <Stack spacing={0.85} sx={{ minWidth: 0 }}>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
              {message.content}
            </Typography>
            {message.files?.length ? <UserMessageFiles files={message.files} /> : null}
          </Stack>
        )}
      </Box>
    </Stack>
  );
}

function OpenAppActionButton({
  action,
  openingAppIds,
  t,
  onOpenApp,
}: {
  action: Extract<NonNullable<ChatMessage['action']>, { type: 'open-app' }>;
  openingAppIds: Set<string>;
  t: AppDictionary;
  onOpenApp: (appId: string) => void;
}) {
  const isOpening = openingAppIds.has(action.appId);

  return (
    <Button
      variant="contained"
      size="small"
      startIcon={isOpening ? <CircularProgress color="inherit" size={14} /> : undefined}
      disabled={isOpening}
      aria-busy={isOpening}
      onClick={() => onOpenApp(action.appId)}
      sx={{ alignSelf: 'flex-start', maxWidth: '100%', whiteSpace: 'normal', overflowWrap: 'anywhere' }}
    >
      {isOpening ? t.actions.opening : action.label}
    </Button>
  );
}

function PermissionActionCard({
  action,
  respondingPermissionIds,
  t,
  onRespondPermission,
}: {
  action: Extract<NonNullable<ChatMessage['action']>, { type: 'permission' }>;
  respondingPermissionIds: Set<string>;
  t: AppDictionary;
  onRespondPermission: (runId: string, requestId: string, decision: 'allow' | 'deny') => void;
}) {
  const theme = useTheme();
  const responseKey = `${action.runId}:${action.request.requestId}`;
  const status = action.status ?? 'pending';
  const isPending = status === 'pending';
  const isResponding = isPending && respondingPermissionIds.has(responseKey);

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 1.5,
        borderRadius: 1,
        minWidth: 0,
        maxWidth: '100%',
        bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'background.paper',
      }}
    >
      <Stack spacing={1}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Chip
            size="small"
            color={status === 'approved' ? 'success' : status === 'denied' ? 'default' : 'warning'}
            label={
              status === 'approved'
                ? t.sections.chat.permissionApproved
                : status === 'denied'
                  ? t.sections.chat.permissionDenied
                  : t.sections.chat.permissionBadge
            }
          />
          <Chip
            size="small"
            variant="outlined"
            label={action.request.resource}
            sx={{ maxWidth: '100%', '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' } }}
          />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
          {action.request.reason}
        </Typography>
        {isPending ? (
          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              size="small"
              disabled={isResponding}
              startIcon={isResponding ? <CircularProgress size={14} color="inherit" /> : undefined}
              onClick={() => onRespondPermission(action.runId, action.request.requestId, 'allow')}
            >
              {t.sections.chat.permissionApprove}
            </Button>
            <Button
              variant="outlined"
              color="inherit"
              size="small"
              disabled={isResponding}
              onClick={() => onRespondPermission(action.runId, action.request.requestId, 'deny')}
            >
              {t.sections.chat.permissionDeny}
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}

function UserMessageFiles({ files }: { files: NonNullable<ChatMessage['files']> }) {
  const theme = useTheme();

  return (
    <Stack
      direction="row"
      spacing={0.75}
      flexWrap="wrap"
      useFlexGap
      sx={{
        maxWidth: '100%',
        alignItems: 'flex-start',
        overflow: 'hidden',
      }}
    >
      {files.map((file) => (
        <Chip
          key={`${file.source}-${file.id}`}
          size="small"
          label={
            file.source === 'mentioned'
              ? `@${compactFileName(file.name)}`
              : `${compactFileName(file.name)} · ${formatBytes(file.sizeBytes)}`
          }
          title={file.displayPath ?? file.relativePath}
          variant={file.source === 'mentioned' ? 'outlined' : 'filled'}
          sx={{
            boxSizing: 'border-box',
            height: 28,
            maxWidth: 'min(100%, 280px)',
            borderRadius: '999px',
            bgcolor: file.source === 'mentioned' ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.2)',
            border: '1px solid rgba(255,255,255,0.58)',
            color: theme.palette.primary.contrastText,
            fontSize: 12,
            fontWeight: 700,
            '& .MuiChip-label': {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: 'block',
              px: 1.25,
              lineHeight: '26px',
            },
          }}
        />
      ))}
    </Stack>
  );
}
