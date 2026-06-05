import { Alert, Button, Chip, Paper, Stack, TextField, Typography } from '@mui/material';
import ArrowBackRounded from '@mui/icons-material/ArrowBackRounded';
import ExtensionRounded from '@mui/icons-material/ExtensionRounded';
import { useCallback, useEffect, useState } from 'react';
import type {
  AgentToolDefinition,
  AgentToolPackageDefinition,
  AgentToolSettings,
  CallOfficialToolResult,
  OfficialToolRuntimeEvent,
  OfficialToolSummary,
} from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { PermissionList } from './PermissionList';

export const OfficialToolDetail = ({
  tool,
  toolPackage,
  settings,
  busyToolId,
  busyOfficialToolId,
  errorMessage,
  t,
  onBack,
  onConnect,
  onDisconnect,
  onStartWhatsAppPairing,
  onGetWhatsAppStatus,
  onOfficialToolEvent,
  onApprovalChange,
}: {
  tool: OfficialToolSummary;
  toolPackage: AgentToolPackageDefinition | null;
  settings: AgentToolSettings;
  busyToolId: string | null;
  busyOfficialToolId: string | null;
  errorMessage: string | null;
  t: AppDictionary;
  onBack: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onStartWhatsAppPairing?: (method: 'qr' | 'pairing_code', phoneNumber?: string) => Promise<CallOfficialToolResult>;
  onGetWhatsAppStatus?: () => Promise<CallOfficialToolResult>;
  onOfficialToolEvent?: (listener: (event: OfficialToolRuntimeEvent) => void) => () => void;
  onApprovalChange: (toolId: AgentToolDefinition['id'], requiresApproval: boolean) => void;
}) => {
  const [whatsAppStatus, setWhatsAppStatus] = useState<WhatsAppStatusData | null>(null);
  const [whatsAppEvent, setWhatsAppEvent] = useState<OfficialToolRuntimeEvent | null>(null);
  const connected = tool.id === 'whatsapp' ? whatsAppStatus?.connected === true : Boolean(tool.configured);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingResult, setPairingResult] = useState<CallOfficialToolResult | null>(null);
  const refreshWhatsAppStatus = useCallback(async () => {
    if (!onGetWhatsAppStatus) {
      return;
    }
    const result = await onGetWhatsAppStatus();
    if (result.success && result.data && typeof result.data === 'object') {
      setWhatsAppStatus(result.data as WhatsAppStatusData);
    }
  }, [onGetWhatsAppStatus]);
  useEffect(() => {
    if (tool.id !== 'whatsapp') {
      return;
    }
    void refreshWhatsAppStatus();
  }, [refreshWhatsAppStatus, tool.id]);
  useEffect(() => {
    if (tool.id !== 'whatsapp' || !onOfficialToolEvent) {
      return;
    }
    return onOfficialToolEvent((event) => {
      if (event.toolId !== 'whatsapp') {
        return;
      }
      setWhatsAppEvent(event);
      void refreshWhatsAppStatus();
    });
  }, [onOfficialToolEvent, refreshWhatsAppStatus, tool.id]);
  const startPairing = async (method: 'qr' | 'pairing_code') => {
    if (!onStartWhatsAppPairing) {
      return;
    }
    setPairingBusy(true);
    setPairingResult(null);
    try {
      setPairingResult(await onStartWhatsAppPairing(method, method === 'pairing_code' ? phoneNumber : undefined));
      await refreshWhatsAppStatus();
    } finally {
      setPairingBusy(false);
    }
  };
  const disconnect = () => {
    if (tool.id === 'whatsapp' && !window.confirm(t.sections.tools.whatsappDisconnectConfirm)) {
      return;
    }
    onDisconnect();
  };
  const pairingData = pairingResult?.data && typeof pairingResult.data === 'object'
    ? pairingResult.data as Record<string, unknown>
    : null;
  return (
    <Stack spacing={1.5}>
      <Button variant="text" size="small" startIcon={<ArrowBackRounded />} onClick={onBack} sx={{ alignSelf: 'flex-start' }}>
        {t.sections.tools.title}
      </Button>
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', md: 'center' }}
        >
          <Stack direction="row" spacing={2} alignItems="center">
            <ExtensionRounded color="primary" sx={{ width: 44, height: 44, flexShrink: 0 }} />
            <Stack spacing={0.5}>
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <Typography variant="h6">{tool.name}</Typography>
                <Chip size="small" color={connected ? 'success' : 'default'} label={connected ? t.sections.tools.active : t.sections.tools.inactive} />
              </Stack>
              <Typography variant="body2" color="text.secondary">{tool.description}</Typography>
            </Stack>
          </Stack>
          {connected ? (
            <Button color="error" variant="outlined" disabled={busyOfficialToolId === tool.id} onClick={disconnect}>
              {tool.id === 'whatsapp' ? t.sections.tools.whatsappResetSession : t.sections.tools.disconnect}
            </Button>
          ) : (
            <Button variant="contained" disabled={busyOfficialToolId === tool.id} onClick={onConnect}>
              {t.sections.tools.activateTool}
            </Button>
          )}
        </Stack>
      </Paper>
      {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}
      {tool.id === 'whatsapp' ? (
        <Paper variant="outlined" sx={{ p: 2, borderRadius: 1 }}>
          <Stack spacing={1.5}>
            {connected ? (
              <>
                <Typography variant="subtitle1" fontWeight={700}>{t.sections.tools.whatsappConnectedDataTitle}</Typography>
                <WhatsAppRuntimeEventAlert event={whatsAppEvent} t={t} />
                <Alert severity="info">{t.sections.tools.whatsappConnectedHelp}</Alert>
                <WhatsAppStorageGrid status={whatsAppStatus} t={t} />
              </>
            ) : null}
            {!connected ? (
              <>
                <Typography variant="subtitle1" fontWeight={700}>
                  {whatsAppStatus?.needsReconnect ? t.sections.tools.whatsappReconnectTitle : t.sections.tools.whatsappPairingTitle}
                </Typography>
                <Typography variant="body2" color="text.secondary">{t.sections.tools.whatsappPairingBody}</Typography>
                <WhatsAppRuntimeEventAlert event={whatsAppEvent} t={t} />
                {whatsAppStatus?.configured ? (
                  <Alert severity="warning">{whatsAppStatus.lastDisconnectReason ?? t.sections.tools.whatsappResetSessionHelp}</Alert>
                ) : (
                  <Alert severity="info">{t.sections.tools.whatsappResetSessionHelp}</Alert>
                )}
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
                  <Button variant="contained" disabled={pairingBusy || busyOfficialToolId === tool.id} onClick={() => void startPairing('qr')}>
                    {t.sections.tools.showWhatsAppQr}
                  </Button>
                  <TextField
                    size="small"
                    label={t.sections.tools.whatsappPhoneLabel}
                    value={phoneNumber}
                    onChange={(event) => setPhoneNumber(event.target.value)}
                  />
                  <Button variant="outlined" disabled={pairingBusy || busyOfficialToolId === tool.id} onClick={() => void startPairing('pairing_code')}>
                    {t.sections.tools.showWhatsAppPairingCode}
                  </Button>
                </Stack>
              </>
            ) : null}
            {pairingResult && !pairingResult.success ? (
              <Alert severity="error">{pairingResult.userMessage ?? t.sections.tools.saveError}</Alert>
            ) : null}
            {typeof pairingData?.qrDataUrl === 'string' ? (
              <Stack spacing={1} alignItems="flex-start">
                <Typography variant="body2" color="text.secondary">{t.sections.tools.whatsappQrHelp}</Typography>
                <img src={pairingData.qrDataUrl} alt={t.sections.tools.whatsappQrAlt} style={{ width: 220, height: 220 }} />
              </Stack>
            ) : null}
            {typeof pairingData?.pairingCode === 'string' ? (
              <Alert severity="info">
                {t.sections.tools.whatsappPairingCodeLabel}: <strong>{pairingData.pairingCode}</strong>
              </Alert>
            ) : null}
          </Stack>
        </Paper>
      ) : null}
      {toolPackage ? (
        <PermissionList
          tools={toolPackage.tools}
          settings={settings}
          busyToolId={busyToolId}
          t={t}
          onboardingTarget={`official-tool-permissions-${tool.id}`}
          onApprovalChange={onApprovalChange}
        />
      ) : null}
    </Stack>
  );
};

const WhatsAppRuntimeEventAlert = ({ event, t }: { event: OfficialToolRuntimeEvent | null; t: AppDictionary }) => {
  if (!event) {
    return null;
  }
  const message = whatsappRuntimeMessage(event, t);
  if (!message) {
    return null;
  }
  const severity = event.phase === 'disconnected' || event.phase === 'error'
    ? 'warning'
    : event.phase === 'connected' || event.phase === 'sync_ready'
      ? 'success'
      : 'info';
  return <Alert severity={severity}>{message}</Alert>;
};

interface WhatsAppStatusData {
  connected?: boolean;
  configured?: boolean;
  needsReconnect?: boolean;
  lastDisconnectReason?: string;
  storage?: {
    chatCount?: number;
    messageCount?: number;
    attachmentCount?: number;
    downloadedAttachmentCount?: number;
    databaseBytes?: number;
    downloadsBytes?: number;
    lastMessageAt?: string;
    lastSyncAt?: string;
  };
}

const whatsappRuntimeMessage = (event: OfficialToolRuntimeEvent, t: AppDictionary): string => {
  const copyByPhase: Partial<Record<OfficialToolRuntimeEvent['phase'], string>> = {
    starting: t.sections.tools.whatsappRuntimeStarting,
    connecting: t.sections.tools.whatsappRuntimeConnecting,
    qr_available: t.sections.tools.whatsappRuntimeQrAvailable,
    pairing_code_ready: t.sections.tools.whatsappRuntimePairingCodeReady,
    connected: t.sections.tools.whatsappRuntimeConnected,
    history_sync: t.sections.tools.whatsappRuntimeHistorySync,
    messages_ingested: t.sections.tools.whatsappRuntimeMessagesIngested,
    chats_ingested: t.sections.tools.whatsappRuntimeChatsIngested,
    contacts_ingested: t.sections.tools.whatsappRuntimeContactsIngested,
    sync_ready: t.sections.tools.whatsappRuntimeSyncReady,
    disconnected: t.sections.tools.whatsappRuntimeDisconnected,
    reconnecting: t.sections.tools.whatsappRuntimeReconnecting,
    reset: t.sections.tools.whatsappRuntimeReset,
    stopped: t.sections.tools.whatsappRuntimeStopped,
    error: t.sections.tools.whatsappRuntimeDisconnected,
  };
  const base = copyByPhase[event.phase] ?? '';
  const countText = whatsappRuntimeCounts(event, t);
  const reasonText = event.reason ? ` ${event.reason}` : '';
  return [base, countText, reasonText].filter(Boolean).join(' ');
};

const whatsappRuntimeCounts = (event: OfficialToolRuntimeEvent, t: AppDictionary): string => {
  const parts = [
    typeof event.counts?.messages === 'number' ? `${event.counts.messages.toLocaleString()} ${t.sections.tools.whatsappStorageMessages.toLowerCase()}` : '',
    typeof event.counts?.chats === 'number' ? `${event.counts.chats.toLocaleString()} ${t.sections.tools.whatsappStorageChats.toLowerCase()}` : '',
    typeof event.counts?.contacts === 'number' ? `${event.counts.contacts.toLocaleString()} ${t.sections.tools.whatsappRuntimeContactsLabel}` : '',
  ].filter(Boolean);
  return parts.length > 0 ? `(${parts.join(', ')})` : '';
};

const WhatsAppStorageGrid = ({ status, t }: { status: WhatsAppStatusData | null; t: AppDictionary }) => {
  const storage = status?.storage ?? {};
  const items = [
    [t.sections.tools.whatsappStorageChats, formatCount(storage.chatCount)],
    [t.sections.tools.whatsappStorageMessages, formatCount(storage.messageCount)],
    [t.sections.tools.whatsappStorageAttachments, formatCount(storage.attachmentCount)],
    [t.sections.tools.whatsappStorageDownloads, formatCount(storage.downloadedAttachmentCount)],
    [t.sections.tools.whatsappStorageDatabase, formatBytes(storage.databaseBytes)],
    [t.sections.tools.whatsappStorageFiles, formatBytes(storage.downloadsBytes)],
    [t.sections.tools.whatsappLastMessage, formatDate(storage.lastMessageAt)],
    [t.sections.tools.whatsappLastSync, formatDate(storage.lastSyncAt)],
  ];
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
      {items.map(([label, value]) => (
        <Paper key={label} variant="outlined" sx={{ p: 1.25, borderRadius: 1, minWidth: 140 }}>
          <Typography variant="caption" color="text.secondary">{label}</Typography>
          <Typography variant="body2" fontWeight={700}>{value}</Typography>
        </Paper>
      ))}
    </Stack>
  );
};

const formatCount = (value: unknown): string => (
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '0'
);

const formatBytes = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatDate = (value: unknown): string => {
  if (typeof value !== 'string' || !value) {
    return '-';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};
