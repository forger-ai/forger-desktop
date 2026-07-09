import type { BrowserWindow } from 'electron';

import { appendDesktopLog } from '../desktop-logger';

type StartupStepStatus = 'active' | 'success' | 'failed';

export type StartupLogger = {
  step: (event: string, callback: () => Promise<void> | void, context?: Record<string, unknown>) => Promise<void>;
  event: (event: string, context?: Record<string, unknown>) => Promise<void>;
};

type StartupProgressListener = (update: {
  event: string;
  status: StartupStepStatus;
  context?: Record<string, unknown>;
  error?: unknown;
}) => void;

export const createStartupLogger = (
  getForgerMetadataRoot: () => string,
  onProgress?: StartupProgressListener,
): StartupLogger => {
  const append = async (
    event: string,
    context?: Record<string, unknown>,
    error?: unknown,
    level: 'info' | 'error' = error ? 'error' : 'info',
  ): Promise<void> => {
    try {
      await appendDesktopLog({
        metadataRoot: getForgerMetadataRoot(),
        level,
        service: 'desktop-main',
        event,
        ...(context ? { context } : {}),
        ...(error ? { error } : {}),
      });
    } catch {
      // appendDesktopLog already fails closed; this guard keeps startup logging non-blocking.
    }
  };

  return {
    event: async (event, context) => {
      await append(event, context);
      onProgress?.({ event, status: 'active', context });
    },
    step: async (event, callback, context) => {
      const startedAt = Date.now();
      await append(`${event}:start`, context);
      onProgress?.({ event, status: 'active', context });
      try {
        await callback();
        const successContext = {
          ...context,
          durationMs: Date.now() - startedAt,
        };
        await append(`${event}:success`, successContext);
        onProgress?.({ event, status: 'success', context: successContext });
      } catch (error) {
        const failedContext = {
          ...context,
          durationMs: Date.now() - startedAt,
        };
        await append(`${event}:failed`, failedContext, error);
        onProgress?.({ event, status: 'failed', context: failedContext, error });
        throw error;
      }
    },
  };
};

const escapeHtml = (value: unknown): string =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const startupStepLabels = {
  es: {
    'startup:ready': 'Preparando Forger',
    'startup:directory': 'Preparando carpetas locales',
    'startup:global_agents_context': 'Preparando contexto de agentes',
    'startup:settings:load': 'Cargando configuracion',
    'startup:secrets_store:create': 'Preparando credenciales locales',
    'startup:legacy_external_tools_cleanup': 'Limpiando conexiones antiguas',
    'startup:official_tools:create': 'Preparando herramientas',
    'startup:official_tools:load': 'Cargando herramientas',
    'startup:official_tools:start_active': 'Iniciando herramientas conectadas',
    'startup:speech_to_text:start_configured': 'Iniciando transcripcion local',
    'startup:agent_tool_settings:load': 'Cargando permisos de herramientas',
    'startup:forger_account_store:create': 'Preparando cuenta local',
    'startup:forger_account_store:load': 'Cargando cuenta',
    'startup:cloud_identity_store:create': 'Preparando identidad cloud',
    'startup:cloud_identity_store:summary': 'Verificando identidad cloud',
    'startup:cloud_sync_settings:load': 'Cargando sincronizacion cloud',
    'startup:memory_store:create': 'Preparando memoria',
    'startup:registry:load': 'Cargando apps instaladas',
    'startup:dev_catalog:start': 'Preparando catalogo local',
    'startup:backend_client:create': 'Preparando conexion cloud',
    'startup:oauth:google:register': 'Preparando login con Google',
    'startup:oauth:apple:register': 'Preparando login con Apple',
    'startup:cloud_device_manager:create': 'Preparando dispositivo cloud',
    'startup:cloud_device_manager:start': 'Conectando dispositivo cloud',
    'startup:forger_mcp_server:create': 'Preparando herramientas de Forger',
    'startup:forger_mcp_server:start': 'Iniciando herramientas de Forger',
    'startup:app_mcp_manager:create': 'Preparando herramientas de apps',
    'startup:file_library:create': 'Preparando archivos compartidos',
    'startup:file_library:cleanup_chat_staging': 'Limpiando archivos temporales',
    'startup:chat_orchestrator:create': 'Preparando chat',
    'startup:app_agent_task_manager:create': 'Preparando tareas de agentes',
    'startup:app_agent_conversation_manager:create': 'Preparando conversaciones de agentes',
    'startup:desktop_runtime_bridge:create': 'Preparando puente local',
    'startup:desktop_runtime_bridge:start': 'Iniciando puente local',
    'startup:automation_manager:create': 'Preparando automatizaciones',
    'startup:automation_manager:initialize': 'Cargando automatizaciones',
    'startup:personal_agent_routine_manager:initialize': 'Cargando rutinas de agentes',
    'startup:memory_maintenance_manager:create': 'Preparando mantenimiento de memoria',
    'startup:memory_maintenance_manager:initialize': 'Cargando mantenimiento de memoria',
    'startup:ipc_handlers:register': 'Preparando comunicacion interna',
    'startup:catalog_statuses:ensure': 'Actualizando estado de apps',
    'startup:main_window:create': 'Abriendo Forger',
    'startup:main_window:create_on_activate': 'Abriendo Forger',
    'startup:failed': 'Revisando error de inicio',
  },
  en: {
    'startup:ready': 'Preparing Forger',
    'startup:directory': 'Preparing local folders',
    'startup:global_agents_context': 'Preparing agent context',
    'startup:settings:load': 'Loading settings',
    'startup:secrets_store:create': 'Preparing local credentials',
    'startup:legacy_external_tools_cleanup': 'Cleaning old connections',
    'startup:official_tools:create': 'Preparing tools',
    'startup:official_tools:load': 'Loading tools',
    'startup:official_tools:start_active': 'Starting connected tools',
    'startup:speech_to_text:start_configured': 'Starting local transcription',
    'startup:agent_tool_settings:load': 'Loading tool permissions',
    'startup:forger_account_store:create': 'Preparing local account',
    'startup:forger_account_store:load': 'Loading account',
    'startup:cloud_identity_store:create': 'Preparing cloud identity',
    'startup:cloud_identity_store:summary': 'Checking cloud identity',
    'startup:cloud_sync_settings:load': 'Loading cloud sync',
    'startup:memory_store:create': 'Preparing memory',
    'startup:registry:load': 'Loading installed apps',
    'startup:dev_catalog:start': 'Preparing local catalog',
    'startup:backend_client:create': 'Preparing cloud connection',
    'startup:oauth:google:register': 'Preparing Google login',
    'startup:oauth:apple:register': 'Preparing Apple login',
    'startup:cloud_device_manager:create': 'Preparing cloud device',
    'startup:cloud_device_manager:start': 'Connecting cloud device',
    'startup:forger_mcp_server:create': 'Preparing Forger tools',
    'startup:forger_mcp_server:start': 'Starting Forger tools',
    'startup:app_mcp_manager:create': 'Preparing app tools',
    'startup:file_library:create': 'Preparing shared files',
    'startup:file_library:cleanup_chat_staging': 'Cleaning temporary files',
    'startup:chat_orchestrator:create': 'Preparing chat',
    'startup:app_agent_task_manager:create': 'Preparing agent tasks',
    'startup:app_agent_conversation_manager:create': 'Preparing agent conversations',
    'startup:desktop_runtime_bridge:create': 'Preparing local bridge',
    'startup:desktop_runtime_bridge:start': 'Starting local bridge',
    'startup:automation_manager:create': 'Preparing automations',
    'startup:automation_manager:initialize': 'Loading automations',
    'startup:personal_agent_routine_manager:initialize': 'Loading agent routines',
    'startup:memory_maintenance_manager:create': 'Preparing memory maintenance',
    'startup:memory_maintenance_manager:initialize': 'Loading memory maintenance',
    'startup:ipc_handlers:register': 'Preparing internal communication',
    'startup:catalog_statuses:ensure': 'Updating app status',
    'startup:main_window:create': 'Opening Forger',
    'startup:main_window:create_on_activate': 'Opening Forger',
    'startup:failed': 'Checking startup error',
  },
} satisfies Record<'es' | 'en', Record<string, string>>;

const startupCopyForLocale = (locale?: string) => {
  const normalized = locale?.toLowerCase() ?? '';
  if (normalized.startsWith('en')) {
    return {
      title: 'Starting Forger',
      subtitle: 'Preparing your local workspace.',
      ready: 'Forger is getting ready',
      failed: 'Forger could not finish starting',
      opening: 'Opening Forger',
      stepLabels: startupStepLabels.en,
    };
  }
  return {
    title: 'Iniciando Forger',
    subtitle: 'Preparando tu espacio local.',
    ready: 'Forger se esta preparando',
    failed: 'Forger no pudo terminar de iniciar',
    opening: 'Abriendo Forger',
    stepLabels: startupStepLabels.es,
  };
};

export const createStartupLoadingController = (
  BrowserWindowCtor: typeof BrowserWindow,
  locale?: string,
): { update: StartupProgressListener; close: () => void } => {
  if (typeof BrowserWindowCtor !== 'function') {
    return { update: () => undefined, close: () => undefined };
  }
  const copy = startupCopyForLocale(locale);
  const steps: { event: string; label: string; status: StartupStepStatus }[] = [];
  const window = new BrowserWindowCtor({
    width: 520,
    height: 440,
    minWidth: 520,
    minHeight: 440,
    maxWidth: 520,
    maxHeight: 440,
    resizable: false,
    backgroundColor: '#F6F3EE',
    title: copy.title,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  let documentReady = false;
  let pendingProgressScript: string | null = null;

  const renderDocument = (): void => {
    if (typeof window.isDestroyed === 'function' && window.isDestroyed()) {
      return;
    }
    const html = `<!doctype html>
<html lang="${copy.stepLabels === startupStepLabels.en ? 'en' : 'es'}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(copy.title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f3ee; color: #1f2933; }
    main { width: min(390px, calc(100vw - 56px)); }
    .brand { font-size: 28px; font-weight: 750; letter-spacing: 0; margin: 0 0 8px; }
    .subtitle { color: #64707d; font-size: 14px; line-height: 1.45; margin: 0 0 28px; }
    .status { display: flex; gap: 12px; align-items: center; font-size: 16px; font-weight: 650; margin-bottom: 18px; }
    .spinner { width: 18px; height: 18px; border: 2px solid #d5cec1; border-top-color: #2f6f68; border-radius: 999px; animation: spin 900ms linear infinite; }
    .failed .spinner { animation: none; }
    .failed .spinner { border-top-color: #b42318; }
    ol { list-style: none; display: grid; gap: 10px; margin: 0; padding: 0; }
    .step { display: flex; gap: 10px; align-items: center; min-height: 20px; color: #6b7280; font-size: 13px; line-height: 1.35; }
    .step-success { color: #40514f; }
    .step-active { color: #172b2a; font-weight: 650; }
    .step-failed { color: #b42318; font-weight: 650; }
    .dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 999px; background: #c9c1b4; }
    .step-success .dot { background: #2f6f68; }
    .step-active .dot { background: #c58a2a; }
    .step-failed .dot { background: #b42318; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <main id="startup-root">
    <h1 class="brand">Forger</h1>
    <p class="subtitle">${escapeHtml(copy.subtitle)}</p>
    <div class="status"><span class="spinner"></span><span id="startup-status">${escapeHtml(copy.ready)}</span></div>
    <ol id="startup-steps"></ol>
  </main>
</body>
</html>`;
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
  };

  const executeProgressScript = (script: string): void => {
    if (typeof window.isDestroyed === 'function' && window.isDestroyed()) {
      return;
    }
    void window.webContents?.executeJavaScript?.(script, true).catch(() => undefined);
  };

  const markDocumentReady = (): void => {
    documentReady = true;
    const script = pendingProgressScript;
    pendingProgressScript = null;
    if (script) {
      executeProgressScript(script);
    }
  };

  const renderProgress = (currentLabel = copy.ready, failed = false): void => {
    if (typeof window.isDestroyed === 'function' && window.isDestroyed()) {
      return;
    }
    const visibleSteps = steps.slice(-9);
    const script = `
      (() => {
        const root = document.getElementById('startup-root');
        const status = document.getElementById('startup-status');
        const list = document.getElementById('startup-steps');
        if (!root || !status || !list) return;
        root.classList.toggle('failed', ${JSON.stringify(failed)});
        status.textContent = ${JSON.stringify(currentLabel)};
        list.replaceChildren(...${JSON.stringify(visibleSteps)}.map((step) => {
          const item = document.createElement('li');
          item.className = 'step step-' + step.status;
          const dot = document.createElement('span');
          dot.className = 'dot';
          const label = document.createElement('span');
          label.textContent = step.label;
          item.append(dot, label);
          return item;
        }));
      })();
    `;
    if (!documentReady) {
      pendingProgressScript = script;
      return;
    }
    executeProgressScript(script);
  };

  if (typeof window.webContents?.once === 'function') {
    window.webContents.once('did-finish-load', markDocumentReady);
  } else {
    markDocumentReady();
  }
  renderDocument();

  return {
    update: ({ event, status, error }) => {
      const stepLabels = copy.stepLabels as Record<string, string>;
      const label = stepLabels[event] ?? copy.ready;
      const existing = steps.find((step) => step.event === event);
      if (existing) {
        existing.status = status;
      } else {
        steps.push({ event, label, status });
      }
      const currentLabel = status === 'failed'
        ? copy.failed
        : event === 'startup:main_window:create' && status === 'success'
          ? copy.opening
          : label;
      renderProgress(error ? `${currentLabel}` : currentLabel, status === 'failed');
    },
    close: () => {
      if (typeof window.isDestroyed === 'function' && window.isDestroyed()) {
        return;
      }
      window.close();
    },
  };
};
