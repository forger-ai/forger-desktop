import type { InstallPhase } from './types';

export type Locale = 'es' | 'en';

const isLocale = (value: unknown): value is Locale => value === 'es' || value === 'en';

export const defaultLocale: Locale = 'es';

export const normalizeLocale = (value?: string | null): Locale => {
  if (!value) {
    return defaultLocale;
  }
  const normalized = value.toLowerCase();
  if (isLocale(normalized)) {
    return normalized;
  }
  const prefix = normalized.split('-')[0];
  return isLocale(prefix) ? prefix : defaultLocale;
};

export const installProgressByPhase: Record<InstallPhase, number> = {
  starting: 5,
  checking_update: 8,
  downloading: 20,
  extracting: 35,
  preparing_runtime: 50,
  updating_base: 58,
  merging_user_changes: 62,
  installing_backend: 68,
  installing_frontend: 88,
  conflict: 92,
  completed: 100,
  failed: 100,
};

export const sharedCopy = {
  es: {
    install: {
      catalogMissing: 'La app no está disponible para instalar.',
      requiredToolsMissing: 'Esta app necesita herramientas oficiales instaladas y configuradas antes de instalarse.',
      preparing: 'Preparando instalación...',
      starting: 'Iniciando instalación...',
      downloading: 'Descargando app...',
      extracting: 'Preparando archivos de la app...',
      preparingRuntime: 'Preparando runtimes compartidos...',
      installingBackend: 'Instalando dependencias del backend...',
      installingFrontend: 'Instalando dependencias del frontend...',
      installedReady: 'Instalada y lista para abrir.',
      completed: 'Instalación completada.',
      failedStored: 'No se pudo instalar. Puedes reintentar.',
      failed: 'No se pudo completar la instalación. Reintenta.',
    },
    update: {
      appNotInstalled: 'Primero instala esta app.',
      catalogMissing: 'No pudimos revisar la versión disponible.',
      appRunning: 'Detén la app antes de actualizarla.',
      conflictPending: 'Esta app ya tiene una actualización con conflicto pendiente.',
      alreadyLatest: 'Ya tienes la versión más reciente.',
      checking: 'Revisando actualización disponible...',
      dirtyWorktree: 'Antes de actualizar, guarda o descarta los cambios pendientes de esta app.',
      backupFailed: 'No pudimos respaldar tus datos antes de actualizar.',
      downloading: 'Descargando actualización...',
      extracting: 'Preparando versión nueva...',
      updatingBase: 'Guardando la versión nueva...',
      merging: 'Combinando la actualización con tus cambios...',
      mergeFailedStored: 'No pudimos combinar automáticamente la actualización con tus cambios.',
      mergeNeedsHelp: 'La actualización necesita ayuda para combinarse con tus cambios.',
      installedReady: 'Actualización instalada y lista para abrir.',
      completed: 'Actualización completada.',
      failedStored: 'No pudimos actualizar la app. Puedes reintentar.',
      failed: 'No pudimos actualizar la app. Puedes reintentar.',
      noPendingConflict: 'No hay una actualización en conflicto para restaurar.',
      restoredPrevious: 'Restauramos tu versión anterior.',
      restoreFailed: 'No pudimos restaurar la versión anterior.',
    },
    tools: {
      unavailable: 'La herramienta no está disponible.',
      activated: 'Herramienta activada.',
      deactivated: 'Herramienta desactivada.',
      gmailConnected: 'Gmail conectado.',
      gmailConnectFailed: 'No pudimos conectar Gmail.',
      gmailForgerAccountRequired: 'Para conectar Gmail, inicia sesión en Forger Cloud. Forger Cloud permite completar la autenticación segura con Google sin exponer el secreto OAuth en tu desktop.',
      gmailUnavailableForAgent: 'Gmail está desactivada. Pídele al usuario activar y conectar Gmail en la vista Tools de Forger antes de leer o enviar correos.',
      gmailUnavailableForApp: 'Gmail está desactivada. Activa y conecta Gmail en la vista Tools de Forger antes de usarla desde esta app.',
      gmailNotConfiguredForAgent: 'Gmail está activada, pero todavía no está conectada. Pídele al usuario conectar Gmail en la vista Tools de Forger.',
      gmailNotConfiguredForApp: 'Gmail está activada, pero todavía no está conectada. Conecta Gmail en la vista Tools de Forger.',
      configurationError: (toolName: string, error?: string) => `${toolName} tiene un error de configuración${error ? `: ${error}` : '.'}`,
      notReady: 'La herramienta no está lista para usarse.',
    },
    chat: {
      permissionDeniedRun: 'Permiso denegado para ejecutar la acción solicitada.',
      saveVersionSuccess: 'Versión guardada. Puedes volver a la versión anterior cuando quieras.',
      saveVersionFailed: 'No pudimos guardar esta versión. Revisa el cambio y reintenta.',
      undoSuccess: 'Cambio deshecho correctamente.',
      undoFailed: 'No pudimos deshacer el cambio.',
      updateConflictTitle: 'Actualización combinada',
      autoUpdateNoChanges: 'Revisé la app y no encontré cambios que guardar. Si quieres, dime qué ajustar visualmente o qué flujo esperas cambiar.',
      failures: {
        authMissing: 'Primero conecta Codex en Ajustes para usar Chat con cambios reales.',
        appNotInstalled: 'La app objetivo no está instalada en tu workspace privado.',
        permissionDenied: 'No continuamos porque el permiso fue denegado.',
        timeout: 'La solicitud tardó demasiado y fue detenida.',
        sandboxViolation: 'Bloqueamos una acción fuera del workspace permitido.',
        dirtyWorktree: 'Antes de comenzar, al parecer hay cambios sin guardar en tu aplicación. ¿Quieres que guarde esa versión antes de continuar?',
        conflict: 'Detectamos un conflicto con el estado actual de la app.',
        canceled: (logHint: string) => `Solicitud cancelada.${logHint}`,
        codexCliFailed: (snippet: string, logHint: string) =>
          `No pude ejecutar Codex CLI en este equipo. Revisa login y versión en Ajustes.${snippet ? ` Detalle: ${snippet}` : ''}${logHint}`,
        codexRequestFailed: (snippet: string, logHint: string) =>
          `No pude completar la solicitud con Codex.${snippet ? ` Detalle: ${snippet}` : ''}${logHint}`,
      },
    },
    agentTools: {
      memoryApprovalNotRequired: 'La herramienta de memoria no requiere autorización adicional.',
      approvalNotRequired: 'Esta herramienta no requirió autorización adicional.',
      approvalUnavailable: 'No se pudo solicitar autorización para esta herramienta.',
      approvalWaiting: (toolName: string) => `Esperando autorización para ${toolName}...`,
      approvalReceived: 'Autorización recibida. La herramienta continuó con la acción solicitada.',
      approvalRejected: 'La autorización fue rechazada o cancelada.',
      approvalDisplayFailed: 'No se pudo mostrar la autorización para esta herramienta.',
      canceledByUser: 'La acción fue cancelada por el usuario.',
      restartPreparing: 'Preparando reinicio de la app...',
      memoryCreatedGlobal: 'He tomado nota de esto en la memoria de Forger. Puedes verla o eliminarla en Configuraciones > Memoria.',
      memoryCreatedApp: 'He tomado nota de esto para esta app. Puedes administrarlo en Configuraciones > Memoria.',
      memoryUpdated: 'He actualizado esa memoria. Puedes administrarla en Configuraciones > Memoria.',
      memoryDeleted: 'Eliminé esa memoria.',
      memoryNotFound: 'No encontré esa memoria.',
      memoryScopeForbidden: 'No puedo operar memoria fuera del alcance permitido para esta conversación.',
      memoryTextRequired: 'La memoria necesita un texto para guardarse.',
      memoryAppRequired: 'La memoria de app necesita una app asociada.',
      memoryOperationFailed: 'No pude completar la operación de memoria.',
      invalidPromptKind: 'Tipo de prompt inválido.',
    },
    appConversation: {
      defaultTitle: 'Conversación',
      agentThinking: 'El agente está pensando.',
      usingTools: 'El agente está usando herramientas de Studio.',
      done: 'Listo.',
    },
    gmailOAuth: {
      successTitle: 'Gmail conectado',
      successBody: 'Ya puedes volver a Forger.',
      errorTitle: 'No pudimos conectar Gmail',
      errorBody: 'Vuelve a Forger e inténtalo otra vez.',
      notFoundBody: 'Esta página no pertenece al flujo de Gmail.',
      stateMismatch: 'La respuesta de Google no coincide con la solicitud original.',
      googleRejected: 'Google canceló o rechazó la autorización.',
      accessDenied: 'La autorización de Gmail fue cancelada.',
      googleError: 'Google rechazó la autorización de Gmail.',
      codeMissing: 'Google no devolvió un código de autorización.',
      refreshTokenMissing: 'Google no devolvió permiso para mantener la conexión.',
      fallbackError: 'Forger no pudo completar OAuth con Gmail.',
      portUnavailable: 'No pudimos abrir el servidor local de OAuth.',
      timeout: 'La conexión con Gmail expiró.',
    },
    officialTools: {
      gmail: {
        name: 'Gmail',
        description: 'Busca, lee y envía correos de Gmail. Requiere iniciar sesión en Forger antes de conectar la cuenta de Google.',
        secrets: {
          gmail_refresh_token: {
            label: 'Conexión OAuth de Gmail',
            usage: 'Permite renovar el acceso a Gmail sin volver a conectar la cuenta.',
          },
        },
        actions: {
          'gmail.connection.status': {
            name: 'Estado de conexión',
            description: 'Revisa si Gmail está conectado.',
          },
          'gmail.search_messages': {
            name: 'Buscar correos',
            description: 'Busca correos en Gmail usando una consulta.',
          },
          'gmail.read_thread': {
            name: 'Leer conversación',
            description: 'Lee una conversación o mensaje de Gmail e incluye metadata de adjuntos.',
          },
          'gmail.read_attachment': {
            name: 'Leer adjunto',
            description: 'Descarga un adjunto de Gmail y lo deja disponible para el agente.',
          },
          'gmail.send_email': {
            name: 'Enviar correo',
            description: 'Envía un correo desde la cuenta conectada.',
          },
        },
        changelog: ['Base inicial para conexión OAuth y acciones Gmail.'],
      },
    },
  },
  en: {
    install: {
      catalogMissing: 'This app is not available to install.',
      requiredToolsMissing: 'This app needs official tools installed and configured before installation.',
      preparing: 'Preparing installation...',
      starting: 'Starting installation...',
      downloading: 'Downloading app...',
      extracting: 'Preparing app files...',
      preparingRuntime: 'Preparing shared runtimes...',
      installingBackend: 'Installing backend dependencies...',
      installingFrontend: 'Installing frontend dependencies...',
      installedReady: 'Installed and ready to open.',
      completed: 'Installation completed.',
      failedStored: 'Could not install. You can retry.',
      failed: 'Installation could not be completed. Retry.',
    },
    update: {
      appNotInstalled: 'Install this app first.',
      catalogMissing: 'Could not check the available version.',
      appRunning: 'Stop the app before updating it.',
      conflictPending: 'This app already has an update conflict pending.',
      alreadyLatest: 'You already have the latest version.',
      checking: 'Checking available update...',
      dirtyWorktree: "Before updating, save or discard this app's pending changes.",
      backupFailed: 'Could not back up your data before updating.',
      downloading: 'Downloading update...',
      extracting: 'Preparing the new version...',
      updatingBase: 'Saving the new version...',
      merging: 'Combining the update with your changes...',
      mergeFailedStored: 'Could not automatically combine the update with your changes.',
      mergeNeedsHelp: 'The update needs help to combine with your changes.',
      installedReady: 'Update installed and ready to open.',
      completed: 'Update completed.',
      failedStored: 'Could not update the app. You can retry.',
      failed: 'Could not update the app. You can retry.',
      noPendingConflict: 'There is no update conflict to restore.',
      restoredPrevious: 'Your previous version was restored.',
      restoreFailed: 'Could not restore the previous version.',
    },
    tools: {
      unavailable: 'The tool is not available.',
      activated: 'Tool activated.',
      deactivated: 'Tool deactivated.',
      gmailConnected: 'Gmail connected.',
      gmailConnectFailed: 'Could not connect Gmail.',
      gmailForgerAccountRequired: 'To connect Gmail, sign in to Forger Cloud. Forger Cloud lets Forger complete secure Google authentication without exposing the OAuth secret on your desktop.',
      gmailUnavailableForAgent: 'Gmail is inactive. Ask the user to activate and connect Gmail in Forger Tools before reading or sending mail.',
      gmailUnavailableForApp: 'Gmail is inactive. Activate and connect Gmail in Forger Tools before using it from this app.',
      gmailNotConfiguredForAgent: 'Gmail is active, but it is not connected yet. Ask the user to connect Gmail in Forger Tools.',
      gmailNotConfiguredForApp: 'Gmail is active, but it is not connected yet. Connect Gmail in Forger Tools.',
      configurationError: (toolName: string, error?: string) => `${toolName} has a configuration error${error ? `: ${error}` : '.'}`,
      notReady: 'The tool is not ready to use.',
    },
    chat: {
      permissionDeniedRun: 'Permission denied for the requested action.',
      saveVersionSuccess: 'Version saved. You can return to the previous version whenever you want.',
      saveVersionFailed: 'Could not save this version. Review the change and retry.',
      undoSuccess: 'Change undone.',
      undoFailed: 'Could not undo the change.',
      updateConflictTitle: 'Update combined',
      autoUpdateNoChanges: 'I reviewed the app and did not find changes to save. Tell me what visual detail or flow you want adjusted.',
      failures: {
        authMissing: 'Connect Codex in Settings first to use Chat with real changes.',
        appNotInstalled: 'The target app is not installed in your private workspace.',
        permissionDenied: 'We did not continue because permission was denied.',
        timeout: 'The request took too long and was stopped.',
        sandboxViolation: 'An action outside the allowed workspace was blocked.',
        dirtyWorktree: 'Before starting, it looks like this app has unsaved changes. Do you want me to save that version before continuing?',
        conflict: 'We detected a conflict with the current app state.',
        canceled: (logHint: string) => `Request canceled.${logHint}`,
        codexCliFailed: (snippet: string, logHint: string) =>
          `I could not run Codex CLI on this computer. Check login and version in Settings.${snippet ? ` Detail: ${snippet}` : ''}${logHint}`,
        codexRequestFailed: (snippet: string, logHint: string) =>
          `I could not complete the request with Codex.${snippet ? ` Detail: ${snippet}` : ''}${logHint}`,
      },
    },
    agentTools: {
      memoryApprovalNotRequired: 'The memory tool does not require additional authorization.',
      approvalNotRequired: 'This tool did not require additional authorization.',
      approvalUnavailable: 'Could not request authorization for this tool.',
      approvalWaiting: (toolName: string) => `Waiting for authorization for ${toolName}...`,
      approvalReceived: 'Authorization received. The tool continued with the requested action.',
      approvalRejected: 'Authorization was denied or canceled.',
      approvalDisplayFailed: 'Could not show authorization for this tool.',
      canceledByUser: 'The action was canceled by the user.',
      restartPreparing: 'Preparing app restart...',
      memoryCreatedGlobal: 'I saved this in Forger memory. You can view or remove it in Settings > Memory.',
      memoryCreatedApp: 'I saved this for this app. You can manage it in Settings > Memory.',
      memoryUpdated: 'I updated that memory. You can manage it in Settings > Memory.',
      memoryDeleted: 'Deleted that memory.',
      memoryNotFound: 'I could not find that memory.',
      memoryScopeForbidden: 'I cannot operate on memory outside the allowed scope for this conversation.',
      memoryTextRequired: 'Memory needs text before it can be saved.',
      memoryAppRequired: 'App memory needs an associated app.',
      memoryOperationFailed: 'I could not complete the memory operation.',
      invalidPromptKind: 'Invalid prompt type.',
    },
    appConversation: {
      defaultTitle: 'Conversation',
      agentThinking: 'The agent is thinking.',
      usingTools: 'The agent is using Studio tools.',
      done: 'Done.',
    },
    gmailOAuth: {
      successTitle: 'Gmail connected',
      successBody: 'You can return to Forger.',
      errorTitle: 'Could not connect Gmail',
      errorBody: 'Return to Forger and try again.',
      notFoundBody: 'This page is not part of the Gmail connection flow.',
      stateMismatch: "Google's response does not match the original request.",
      googleRejected: 'Google canceled or rejected the authorization.',
      accessDenied: 'Gmail authorization was canceled.',
      googleError: 'Google rejected Gmail authorization.',
      codeMissing: 'Google did not return an authorization code.',
      refreshTokenMissing: 'Google did not grant permission to keep the connection.',
      fallbackError: 'Forger could not complete Gmail OAuth.',
      portUnavailable: 'Could not open the local OAuth server.',
      timeout: 'The Gmail connection timed out.',
    },
    officialTools: {
      gmail: {
        name: 'Gmail',
        description: 'Search, read, and send Gmail messages. Requires signing in to Forger before connecting the Google account.',
        secrets: {
          gmail_refresh_token: {
            label: 'Gmail OAuth connection',
            usage: 'Allows Gmail access to refresh without reconnecting the account.',
          },
        },
        actions: {
          'gmail.connection.status': {
            name: 'Connection status',
            description: 'Checks whether Gmail is connected.',
          },
          'gmail.search_messages': {
            name: 'Search messages',
            description: 'Searches Gmail messages with a query.',
          },
          'gmail.read_thread': {
            name: 'Read conversation',
            description: 'Reads a Gmail conversation or message and includes attachment metadata.',
          },
          'gmail.read_attachment': {
            name: 'Read attachment',
            description: 'Downloads a Gmail attachment and makes it available to the agent.',
          },
          'gmail.send_email': {
            name: 'Send email',
            description: 'Sends an email from the connected account.',
          },
        },
        changelog: ['Initial base for Gmail OAuth connection and actions.'],
      },
    },
  },
} as const;

export const getSharedCopy = (locale?: string | null) => sharedCopy[normalizeLocale(locale)];
