import { Box, type AlertColor } from '@mui/material';
import type { ReactNode } from 'react';
import type { AppSummary, BackgroundTask, CloudFriendship, DesktopUpdateState, ForgerAccountSession, FriendChatWindowOpenResult } from '@shared/types';
import type { AppDictionary } from '@renderer/i18n';
import { Sidebar, type View } from './Sidebar';
import { Topbar } from './Topbar';

interface AppShellProps {
  currentView: View;
  onNavigate: (view: View) => void;
  t: AppDictionary;
  chatModeLabel?: string | null;
  dataApps: AppSummary[];
  selectedDataAppId: string | null;
  getAppMeta: (appId: string) => { name: string; description: string };
  onSelectDataApp: (appId: string | null) => void;
  onOpenCloudModal: () => void;
  account: ForgerAccountSession;
  accountBusy: boolean;
  onOpenFriendChat: (friendship: CloudFriendship) => Promise<FriendChatWindowOpenResult> | FriendChatWindowOpenResult;
  onSocialNotify: (message: string, severity?: AlertColor) => void;
  onUpdateUsername: (username: string) => Promise<boolean>;
  onLogout: () => void;
  backgroundTasks: BackgroundTask[];
  backgroundTasksOpen: boolean;
  activeBackgroundTaskCount: number;
  onOpenBackgroundTasks: () => void;
  onCloseBackgroundTasks: () => void;
  onOpenBackgroundTaskHistory: () => void;
  onOpenBackgroundTask: (taskId: string) => void;
  desktopUpdateState: DesktopUpdateState;
  advancedMode: boolean;
  children: ReactNode;
}

export function AppShell({
  currentView,
  onNavigate,
  t,
  chatModeLabel,
  dataApps,
  selectedDataAppId,
  getAppMeta,
  onSelectDataApp,
  onOpenCloudModal,
  account,
  accountBusy,
  onOpenFriendChat,
  onSocialNotify,
  onUpdateUsername,
  onLogout,
  backgroundTasks,
  backgroundTasksOpen,
  activeBackgroundTaskCount,
  onOpenBackgroundTasks,
  onCloseBackgroundTasks,
  onOpenBackgroundTaskHistory,
  onOpenBackgroundTask,
  desktopUpdateState,
  advancedMode,
  children,
}: AppShellProps) {
  return (
    <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden', WebkitAppRegion: 'no-drag' }}>
      <Sidebar
        currentView={currentView}
        onNavigate={onNavigate}
        t={t}
        desktopUpdateState={desktopUpdateState}
        advancedMode={advancedMode}
      />
      <Box
        component="main"
        sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}
      >
        <Topbar
          currentView={currentView}
          t={t}
          chatModeLabel={chatModeLabel}
          dataApps={dataApps}
          selectedDataAppId={selectedDataAppId}
          getAppMeta={getAppMeta}
          onSelectDataApp={onSelectDataApp}
          onOpenCloudModal={onOpenCloudModal}
          account={account}
          accountBusy={accountBusy}
          onOpenFriendChat={onOpenFriendChat}
          onSocialNotify={onSocialNotify}
          onUpdateUsername={onUpdateUsername}
          onLogout={onLogout}
          backgroundTasks={backgroundTasks}
          backgroundTasksOpen={backgroundTasksOpen}
          activeBackgroundTaskCount={activeBackgroundTaskCount}
          onOpenBackgroundTasks={onOpenBackgroundTasks}
          onCloseBackgroundTasks={onCloseBackgroundTasks}
          onOpenBackgroundTaskHistory={onOpenBackgroundTaskHistory}
          onOpenBackgroundTask={onOpenBackgroundTask}
        />
        <Box sx={{ p: 3, flex: 1, minHeight: 0, overflowY: 'auto', WebkitAppRegion: 'no-drag' }}>{children}</Box>
      </Box>
    </Box>
  );
}
