import { Box } from '@mui/material';
import type { ReactNode } from 'react';
import type { AppSummary, BackgroundTask, CloudStorageUsage, DesktopUpdateState, ForgerAccountSession } from '@shared/types';
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
  cloudStorageUsage: CloudStorageUsage | null;
  cloudStorageBusy: boolean;
  onOpenStorageSettings: () => void;
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
  showForumNav: boolean;
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
  cloudStorageUsage,
  cloudStorageBusy,
  onOpenStorageSettings,
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
  showForumNav,
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
        showForumNav={showForumNav}
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
          cloudStorageUsage={cloudStorageUsage}
          cloudStorageBusy={cloudStorageBusy}
          onOpenStorageSettings={onOpenStorageSettings}
          onOpenSocialTab={() => onNavigate('friends')}
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
