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
      stoppingApp: 'Deteniendo la app para actualizarla...',
      stopFailed: 'No pudimos detener la app para actualizarla.',
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
      whatsappActivated: 'WhatsApp activado. Conecta la cuenta desde el chat con QR o codigo de vinculacion.',
      chromeExtensionConnected: 'Forger Chrome Extension conectada.',
      chromeExtensionWaiting: 'Forger Chrome Extension quedo preparada. Carga o abre la extension en Chrome para completar la conexion.',
      chromeExtensionConfigureFailed: 'No pudimos preparar Forger Chrome Extension.',
      chromeExtension: {
        invalidOpen: 'Indica una URL http o https valida.',
        openFailed: 'No pudimos abrir Chrome.',
        invalidSessionReview: 'Indica la sesion de Chrome que quieres revisar.',
        urlFailed: 'No pudimos leer la URL de Chrome.',
        invalidNavigate: 'Indica la sesion y una URL http o https valida.',
        navigateFailed: 'No pudimos navegar en Chrome.',
        invalidHtml: 'Indica la sesion de Chrome que quieres leer.',
        htmlFailed: 'No pudimos leer la pagina.',
        invalidWaitForSelector: 'Indica la sesion, el selector y un tiempo de espera valido.',
        waitForSelectorFailed: 'No pudimos esperar ese elemento.',
        invalidSelector: 'Indica la sesion y el selector del elemento.',
        elementActionFailed: 'No pudimos operar ese elemento.',
        invalidInputText: 'Indica la sesion, el selector y el texto.',
        inputFailed: 'No pudimos escribir en ese elemento.',
        invalidSubmitForm: 'Indica la sesion y el selector del formulario o de un elemento dentro del formulario.',
        submitFormFailed: 'No pudimos enviar ese formulario.',
        invalidGetStyles: 'Indica la sesion y el selector del elemento.',
        getStylesFailed: 'No pudimos leer los estilos de ese elemento.',
        invalidSetStyles: 'Indica la sesion, el selector y los estilos permitidos.',
        setStylesFailed: 'No pudimos aplicar esos estilos.',
        invalidCloseWindow: 'Indica la sesion de Chrome que quieres cerrar.',
        closeWindowFailed: 'No pudimos cerrar la ventana de Chrome.',
        invalidCloseSession: 'Indica la sesion de Chrome que quieres cerrar.',
        closeSessionFailed: 'No pudimos cerrar la sesion de Chrome.',
        unknownAction: 'La accion de Chrome no esta disponible.',
        actionFailed: 'No pudimos completar la accion de Chrome.',
        executorMissing: 'La herramienta no tiene executor disponible.',
      },
      gmailUnavailableForAgent: 'Gmail está desactivada. Pídele al usuario activar y conectar Gmail en la vista Tools de Forger antes de leer o enviar correos.',
      gmailUnavailableForApp: 'Gmail está desactivada. Activa y conecta Gmail en la vista Tools de Forger antes de usarla desde esta app.',
      gmailNotConfiguredForAgent: 'Gmail está activada, pero todavía no está conectada. Pídele al usuario conectar Gmail en la vista Tools de Forger.',
      gmailNotConfiguredForApp: 'Gmail está activada, pero todavía no está conectada. Conecta Gmail en la vista Tools de Forger.',
      unavailableForAgent: (toolName: string) => `${toolName} esta desactivada. Pidele al usuario activarla en la vista Tools de Forger antes de usarla.`,
      unavailableForApp: (toolName: string) => `${toolName} esta desactivada. Activa la herramienta en la vista Tools de Forger antes de usarla desde esta app.`,
      notConfiguredForAgent: (toolName: string) => `${toolName} esta activada, pero todavia no esta conectada. Pidele al usuario conectarla en la vista Tools de Forger.`,
      notConfiguredForApp: (toolName: string) => `${toolName} esta activada, pero todavia no esta conectada. Conectala en la vista Tools de Forger.`,
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
      progress: {
        editingFiles: 'Codex está editando archivos de la app.',
      },
      failures: {
        authMissing: 'Primero conecta Codex en Ajustes para usar Chat con cambios reales.',
        appNotInstalled: 'La app objetivo no está instalada en tu workspace privado.',
        permissionDenied: 'No continuamos porque el permiso fue denegado.',
        timeout: 'La solicitud tardó demasiado y fue detenida.',
        quotaExceeded: (providerName: string) =>
          `${providerName || 'El proveedor'} alcanzó el límite de uso de tu cuenta. Ese límite depende de tu suscripción con ${providerName || 'el proveedor'}. Prueba más tarde o cambia de modelo/proveedor en Ajustes.`,
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
      usingTools: 'El agente está usando herramientas de la app.',
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
      whatsapp: {
        name: 'WhatsApp (no oficial)',
        description: 'Lee y envia mensajes de WhatsApp usando una conexion local no oficial basada en WhatsApp Web. Puede necesitar reconexion.',
        secrets: {
          whatsapp_auth_state: {
            label: 'Conexion local de WhatsApp',
            usage: 'La sesion de WhatsApp se guarda localmente en el workspace privado de Forger.',
          },
        },
        actions: {
          'whatsapp.connection.status': {
            name: 'Estado de conexion',
            description: 'Revisa si WhatsApp esta conectado o necesita reconexion.',
          },
          'whatsapp.start_pairing': {
            name: 'Conectar WhatsApp',
            description: 'Genera un QR o codigo para vincular WhatsApp como dispositivo local.',
          },
          'whatsapp.list_chats': {
            name: 'Listar chats',
            description: 'Lista chats de WhatsApp ya observados por Forger.',
          },
          'whatsapp.read_messages': {
            name: 'Leer mensajes',
            description: 'Lee mensajes guardados de un chat observado.',
          },
          'whatsapp.download_attachment': {
            name: 'Descargar adjunto',
            description: 'Descarga bajo demanda un archivo de WhatsApp previamente observado.',
          },
          'whatsapp.send_message': {
            name: 'Enviar mensaje',
            description: 'Envia un mensaje a un chat de WhatsApp previamente observado.',
          },
          'whatsapp.get_chat_details': {
            name: 'Ver detalle de chat',
            description: 'Obtiene detalles disponibles de un numero, grupo o canal de WhatsApp.',
          },
        },
        changelog: ['Base experimental no oficial con Baileys para conexion local, lectura y envio controlado.'],
      },
      forger_chrome_extension: {
        name: 'Forger Chrome Extension',
        description: 'Opera una ventana dedicada de Chrome mediante la extension de Forger y un puente local.',
        secrets: {},
        actions: {
          'forger_chrome_extension.connection.status': {
            name: 'Estado de conexion',
            description: 'Revisa si la extension de Chrome esta conectada.',
          },
          'forger_chrome_extension.open_dedicated_tab': {
            name: 'Abrir pestaña dedicada',
            description: 'Crea una ventana y pestaña de Chrome controlada por Forger.',
          },
          'forger_chrome_extension.get_current_url': {
            name: 'Leer URL actual',
            description: 'Lee la URL actual de una sesion dedicada de Chrome.',
          },
          'forger_chrome_extension.navigate': {
            name: 'Navegar',
            description: 'Navega una sesion dedicada de Chrome a una URL http o https.',
          },
          'forger_chrome_extension.get_html': {
            name: 'Leer HTML',
            description: 'Lee el HTML de la pagina completa o de un selector.',
          },
          'forger_chrome_extension.wait_for_selector': {
            name: 'Esperar selector',
            description: 'Espera hasta que un selector alcance un estado visible, oculto, adjunto o removido.',
          },
          'forger_chrome_extension.click': {
            name: 'Click',
            description: 'Hace click en un elemento encontrado por selector.',
          },
          'forger_chrome_extension.focus': {
            name: 'Foco',
            description: 'Enfoca un elemento encontrado por selector.',
          },
          'forger_chrome_extension.hover': {
            name: 'Hover',
            description: 'Dispara eventos de hover sobre un elemento encontrado por selector.',
          },
          'forger_chrome_extension.input_text': {
            name: 'Escribir texto',
            description: 'Escribe texto en un input o elemento editable encontrado por selector.',
          },
          'forger_chrome_extension.submit_form': {
            name: 'Enviar formulario',
            description: 'Envia el formulario asociado a un elemento encontrado por selector.',
          },
          'forger_chrome_extension.get_styles': {
            name: 'Leer estilos',
            description: 'Lee estilos CSS computados e inline de un elemento encontrado por selector.',
          },
          'forger_chrome_extension.set_styles': {
            name: 'Destacar elemento',
            description: 'Aplica estilos CSS permitidos para destacar un elemento visualmente.',
          },
          'forger_chrome_extension.close_window': {
            name: 'Cerrar ventana',
            description: 'Cierra la ventana dedicada de Chrome asociada a una sesion.',
          },
          'forger_chrome_extension.close_session': {
            name: 'Cerrar sesion',
            description: 'Cierra una ventana dedicada de Chrome controlada por Forger.',
          },
        },
        changelog: ['MVP dev para controlar una ventana dedicada de Chrome mediante extension local.'],
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
      stoppingApp: 'Stopping the app to update it...',
      stopFailed: 'Could not stop the app to update it.',
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
      whatsappActivated: 'WhatsApp activated. Connect the account from chat with a QR or pairing code.',
      chromeExtensionConnected: 'Forger Chrome Extension connected.',
      chromeExtensionWaiting: 'Forger Chrome Extension is prepared. Load or open the Chrome extension to complete the connection.',
      chromeExtensionConfigureFailed: 'Could not prepare Forger Chrome Extension.',
      chromeExtension: {
        invalidOpen: 'Enter a valid http or https URL.',
        openFailed: 'Could not open Chrome.',
        invalidSessionReview: 'Choose the Chrome session to review.',
        urlFailed: 'Could not read the Chrome URL.',
        invalidNavigate: 'Enter the session and a valid http or https URL.',
        navigateFailed: 'Could not navigate in Chrome.',
        invalidHtml: 'Choose the Chrome session to read.',
        htmlFailed: 'Could not read the page.',
        invalidWaitForSelector: 'Enter the session, selector, and a valid timeout.',
        waitForSelectorFailed: 'Could not wait for that element.',
        invalidSelector: 'Enter the session and element selector.',
        elementActionFailed: 'Could not operate that element.',
        invalidInputText: 'Enter the session, selector, and text.',
        inputFailed: 'Could not write into that element.',
        invalidSubmitForm: 'Enter the session and the form selector or an element inside the form.',
        submitFormFailed: 'Could not submit that form.',
        invalidGetStyles: 'Enter the session and element selector.',
        getStylesFailed: 'Could not read that element\'s styles.',
        invalidSetStyles: 'Enter the session, selector, and allowed styles.',
        setStylesFailed: 'Could not apply those styles.',
        invalidCloseWindow: 'Choose the Chrome session to close.',
        closeWindowFailed: 'Could not close the Chrome window.',
        invalidCloseSession: 'Choose the Chrome session to close.',
        closeSessionFailed: 'Could not close the Chrome session.',
        unknownAction: 'That Chrome action is not available.',
        actionFailed: 'Could not complete the Chrome action.',
        executorMissing: 'This tool does not have an available executor.',
      },
      gmailUnavailableForAgent: 'Gmail is inactive. Ask the user to activate and connect Gmail in Forger Tools before reading or sending mail.',
      gmailUnavailableForApp: 'Gmail is inactive. Activate and connect Gmail in Forger Tools before using it from this app.',
      gmailNotConfiguredForAgent: 'Gmail is active, but it is not connected yet. Ask the user to connect Gmail in Forger Tools.',
      gmailNotConfiguredForApp: 'Gmail is active, but it is not connected yet. Connect Gmail in Forger Tools.',
      unavailableForAgent: (toolName: string) => `${toolName} is inactive. Ask the user to activate it in Forger Tools before using it.`,
      unavailableForApp: (toolName: string) => `${toolName} is inactive. Activate it in Forger Tools before using it from this app.`,
      notConfiguredForAgent: (toolName: string) => `${toolName} is active, but it is not connected yet. Ask the user to connect it in Forger Tools.`,
      notConfiguredForApp: (toolName: string) => `${toolName} is active, but it is not connected yet. Connect it in Forger Tools.`,
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
      progress: {
        editingFiles: 'Codex is editing app files.',
      },
      failures: {
        authMissing: 'Connect Codex in Settings first to use Chat with real changes.',
        appNotInstalled: 'The target app is not installed in your private workspace.',
        permissionDenied: 'We did not continue because permission was denied.',
        timeout: 'The request took too long and was stopped.',
        quotaExceeded: (providerName: string) =>
          `${providerName || 'The provider'} reached your account usage limit. That limit depends on your subscription with ${providerName || 'the provider'}. Try again later or change the model/provider in Settings.`,
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
      usingTools: 'The agent is using app tools.',
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
      whatsapp: {
        name: 'WhatsApp (unofficial)',
        description: 'Reads and sends WhatsApp messages with an unofficial local WhatsApp Web connection. It may need reconnection.',
        secrets: {
          whatsapp_auth_state: {
            label: 'Local WhatsApp connection',
            usage: 'The WhatsApp session is stored locally in the private Forger workspace.',
          },
        },
        actions: {
          'whatsapp.connection.status': {
            name: 'Connection status',
            description: 'Checks whether WhatsApp is connected or needs reconnection.',
          },
          'whatsapp.start_pairing': {
            name: 'Connect WhatsApp',
            description: 'Generates a QR or code to link WhatsApp as a local device.',
          },
          'whatsapp.list_chats': {
            name: 'List chats',
            description: 'Lists WhatsApp chats already observed by Forger.',
          },
          'whatsapp.read_messages': {
            name: 'Read messages',
            description: 'Reads saved messages from an observed chat.',
          },
          'whatsapp.download_attachment': {
            name: 'Download attachment',
            description: 'Downloads a previously observed WhatsApp file on demand.',
          },
          'whatsapp.send_message': {
            name: 'Send message',
            description: 'Sends a message to a previously observed WhatsApp chat.',
          },
          'whatsapp.get_chat_details': {
            name: 'Chat details',
            description: 'Gets available details for a WhatsApp number, group, or channel.',
          },
        },
        changelog: ['Experimental unofficial Baileys base for local connection, reading, and controlled sending.'],
      },
      forger_chrome_extension: {
        name: 'Forger Chrome Extension',
        description: 'Operates a dedicated Chrome window through the Forger extension and a local bridge.',
        secrets: {},
        actions: {
          'forger_chrome_extension.connection.status': {
            name: 'Connection status',
            description: 'Checks whether the Chrome extension is connected.',
          },
          'forger_chrome_extension.open_dedicated_tab': {
            name: 'Open dedicated tab',
            description: 'Creates a Chrome window and tab controlled by Forger.',
          },
          'forger_chrome_extension.get_current_url': {
            name: 'Read current URL',
            description: 'Reads the current URL of a dedicated Chrome session.',
          },
          'forger_chrome_extension.navigate': {
            name: 'Navigate',
            description: 'Navigates a dedicated Chrome session to an http or https URL.',
          },
          'forger_chrome_extension.get_html': {
            name: 'Read HTML',
            description: 'Reads full page HTML or selector HTML.',
          },
          'forger_chrome_extension.wait_for_selector': {
            name: 'Wait for selector',
            description: 'Waits until a selector reaches a visible, hidden, attached, or detached state.',
          },
          'forger_chrome_extension.click': {
            name: 'Click',
            description: 'Clicks an element matched by selector.',
          },
          'forger_chrome_extension.focus': {
            name: 'Focus',
            description: 'Focuses an element matched by selector.',
          },
          'forger_chrome_extension.hover': {
            name: 'Hover',
            description: 'Dispatches hover events for an element matched by selector.',
          },
          'forger_chrome_extension.input_text': {
            name: 'Input text',
            description: 'Writes text into an input or editable element matched by selector.',
          },
          'forger_chrome_extension.submit_form': {
            name: 'Submit form',
            description: 'Submits the form associated with an element matched by selector.',
          },
          'forger_chrome_extension.get_styles': {
            name: 'Read styles',
            description: 'Reads computed and inline CSS styles from an element matched by selector.',
          },
          'forger_chrome_extension.set_styles': {
            name: 'Highlight element',
            description: 'Applies allowed CSS styles to visually highlight an element.',
          },
          'forger_chrome_extension.close_window': {
            name: 'Close window',
            description: 'Closes the dedicated Chrome window associated with a session.',
          },
          'forger_chrome_extension.close_session': {
            name: 'Close session',
            description: 'Closes a dedicated Chrome window controlled by Forger.',
          },
        },
        changelog: ['Dev MVP for controlling a dedicated Chrome window through a local extension.'],
      },
    },
  },
} as const;

export const getSharedCopy = (locale?: string | null) => sharedCopy[normalizeLocale(locale)];
