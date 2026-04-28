import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import type { AppSummary } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { Sidebar, type View } from './Sidebar';
import { Topbar } from './Topbar';

interface AppShellProps {
  currentView: View;
  onNavigate: (view: View) => void;
  t: AppDictionary;
  chatApps: AppSummary[];
  selectedChatAppId: string | null;
  dataApps: AppSummary[];
  selectedDataAppId: string | null;
  getAppMeta: (appId: string) => { name: string; description: string };
  onSelectChatApp: (appId: string | null) => void;
  onSelectDataApp: (appId: string | null) => void;
  onOpenCloudModal: () => void;
  children: ReactNode;
}

export function AppShell({
  currentView,
  onNavigate,
  t,
  chatApps,
  selectedChatAppId,
  dataApps,
  selectedDataAppId,
  getAppMeta,
  onSelectChatApp,
  onSelectDataApp,
  onOpenCloudModal,
  children,
}: AppShellProps) {
  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden', WebkitAppRegion: 'no-drag' }}>
      <Sidebar currentView={currentView} onNavigate={onNavigate} t={t} />
      <Box
        component="main"
        sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}
      >
        <Topbar
          currentView={currentView}
          t={t}
          chatApps={chatApps}
          selectedChatAppId={selectedChatAppId}
          dataApps={dataApps}
          selectedDataAppId={selectedDataAppId}
          getAppMeta={getAppMeta}
          onSelectChatApp={onSelectChatApp}
          onSelectDataApp={onSelectDataApp}
          onOpenCloudModal={onOpenCloudModal}
        />
        <Box sx={{ p: 3, flex: 1, minHeight: 0, overflowY: 'auto', WebkitAppRegion: 'no-drag' }}>{children}</Box>
      </Box>
    </Box>
  );
}
