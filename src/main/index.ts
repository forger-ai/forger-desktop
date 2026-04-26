import { app, BrowserWindow, ipcMain } from 'electron';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// better-sqlite3 is optional — gracefully unavailable if not installed / rebuilt
// eslint-disable-next-line @typescript-eslint/no-require-imports
let BetterSqlite3: (typeof import('better-sqlite3')) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3') as typeof import('better-sqlite3');
} catch {
  // package not yet installed or not rebuilt for this Electron version
}
import { settingsSeed } from '../shared/mock-data';
import { IPC_CHANNELS } from '../shared/ipc';
import { ChatOrchestrator } from './chat/orchestrator';
import type {
  AppCategory,
  AppStatus,
  AppSummary,
  CatalogApp,
  ChatApplyRunInput,
  ChatApprovePermissionInput,
  ChatCancelRunInput,
  ChatGetRunInput,
  ChatStartRunInput,
  ChatUndoInput,
  CodexAuthStatus,
  InstallAppResult,
  OpenAppResult,
  RuntimeStatus,
  SessionState,
  SessionUser,
  Settings,
  StopAppResult,
} from '../shared/types';

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const backendBaseUrl = process.env.FORGER_BACKEND_URL ?? 'http://127.0.0.1:3300';
const catalogJsonUrl =
  process.env.FORGER_CATALOG_URL ?? 'https://forger-ai.github.io/apps-catalog/catalog.json';
const DEFAULT_NODE_VERSION = '24';
const DEFAULT_PYTHON_VERSION = '3.12';
const CODEX_CLI_VERSION = '0.125.0';
const FORGER_AGENT_CONTRACT_VERSION = 2;
const FORGER_AGENT_CONTRACT_MARKER = `FORGER_AGENT_CONTRACT_VERSION: ${FORGER_AGENT_CONTRACT_VERSION}`;
const FORGER_AGENT_CONTRACT_MARKER_PREFIX = 'FORGER_AGENT_CONTRACT_VERSION:';

if (isDev) {
  app.setName('Forger Dev');
  app.setPath('userData', path.join(app.getPath('appData'), 'forger-desktop-dev'));
}

const PLATFORM_KEY_BY_RUNTIME: Record<NodeJS.Platform, string> = {
  darwin: 'darwin',
  win32: 'win32',
  linux: 'linux',
  aix: 'aix',
  freebsd: 'freebsd',
  openbsd: 'openbsd',
  sunos: 'sunos',
  android: 'android',
  cygwin: 'cygwin',
  haiku: 'haiku',
  netbsd: 'netbsd',
};

const RUNTIME_PLATFORM_ALIASES = new Set(['darwin_arm64', 'win32_x64']);

interface InstalledAppRecord {
  appId: string;
  name: string;
  description: string;
  category: AppCategory;
  version: string;
  installDir: string;
  status: Exclude<AppStatus, 'not_installed' | 'running'>;
  userMessage?: string;
  requiredNodeVersion: string;
  requiredPythonVersion: string;
}

interface AppRegistry {
  apps: Record<string, InstalledAppRecord>;
}

interface RuntimeBinarySet {
  rootDir: string;
  node?: string;
  npm?: string;
  python?: string;
  pip?: string;
}

interface RunningAppProcess {
  appId: string;
  backend: ChildProcessWithoutNullStreams;
  frontend: ChildProcessWithoutNullStreams;
  backendUrl: string;
  frontendUrl: string;
}

interface PersistedSession {
  token: string;
  user: SessionUser;
}

interface AppManifestService {
  name?: string;
  type?: string;
  port?: number;
  command?: string;
  healthcheck?: string;
  context?: string;
}

interface AppManifestStackSection {
  language?: string;
  framework?: string;
  package_manager?: string;
  database?: string;
  bundler?: string;
  ui?: string;
}

interface AppManifestStack {
  backend?: AppManifestStackSection;
  frontend?: AppManifestStackSection;
}

interface AppManifest {
  name?: string;
  version?: string;
  description?: string;
  stack?: AppManifestStack;
  services?: AppManifestService[];
  scripts?: Record<string, string>;
  skills?: string[];
}

interface StackSkillTemplate {
  id: string;
  description: string;
  body: string;
}

let mainWindow: BrowserWindow | null = null;
let catalogApps: CatalogApp[] = [];
let settings: Settings = structuredClone(settingsSeed);
let sessionToken: string | null = null;
let sessionUser: SessionUser | null = null;
let registry: AppRegistry = { apps: {} };
const runningApps = new Map<string, RunningAppProcess>();
const appWindows = new Map<string, BrowserWindow>();
const stoppingApps = new Set<string>();
const runtimeLocks = new Map<string, Promise<RuntimeBinarySet>>();
let chatOrchestrator: ChatOrchestrator | null = null;

const resolvePlatformAlias = (): string => {
  const platformPrefix = PLATFORM_KEY_BY_RUNTIME[process.platform] ?? process.platform;
  return `${platformPrefix}_${process.arch}`;
};

const getRegistryPath = () => path.join(app.getPath('userData'), 'app_registry.json');
const getSessionPath = () => path.join(app.getPath('userData'), 'session.json');
const getRuntimesRoot = () => path.join(app.getPath('userData'), 'runtimes');
const getTempRoot = () => path.join(app.getPath('userData'), 'tmp');
const getPrivateAppsRoot = () => path.join(os.homedir(), 'Forger', isDev ? 'dev-apps' : 'apps');
const getCodexRoot = () => path.join(app.getPath('userData'), 'codex-cli');
const getCodexHome = () => path.join(app.getPath('userData'), 'codex-home');

const getBundledResourcesRoot = (): string => {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtimes');
  }
  return path.join(app.getAppPath(), 'resources', 'runtimes');
};

const stripArchiveExtension = (fileName: string): string => {
  if (fileName.endsWith('.tar.gz')) {
    return fileName.slice(0, -7);
  }
  if (fileName.endsWith('.tgz')) {
    return fileName.slice(0, -4);
  }
  if (fileName.endsWith('.zip')) {
    return fileName.slice(0, -4);
  }
  return fileName;
};

const runtimePlatformTokens = (platformAlias: string): string[] => {
  const tokens = new Set<string>([platformAlias, platformAlias.replace('_', '-')]);

  if (platformAlias === 'darwin_arm64') {
    tokens.add('darwin-arm64');
    tokens.add('aarch64-apple-darwin');
  }
  if (platformAlias === 'win32_x64') {
    tokens.add('win-x64');
    tokens.add('x86_64-pc-windows-msvc');
    tokens.add('windows-x64');
  }

  return Array.from(tokens);
};

const findRuntimeArchive = async (
  baseDir: string,
  platformAlias: string,
): Promise<string | null> => {
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter((name) => name.endsWith('.zip') || name.endsWith('.tar.gz') || name.endsWith('.tgz'));
    if (files.length === 0) {
      return null;
    }

    const tokens = runtimePlatformTokens(platformAlias);
    const byToken = files.find((name) => tokens.some((token) => name.includes(token)));
    if (byToken) {
      return path.join(baseDir, byToken);
    }

    if (files.length === 1) {
      return path.join(baseDir, files[0]);
    }

    return null;
  } catch {
    return null;
  }
};

const findRuntimeChecksumFile = async (
  baseDir: string,
  archivePath: string,
  platformAlias: string,
): Promise<string | null> => {
  const archiveName = path.basename(archivePath);
  const candidates = [
    `${archiveName}.sha256`,
    `${stripArchiveExtension(archiveName)}.sha256`,
    `${platformAlias}.sha256`,
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(baseDir, candidate);
    try {
      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        return fullPath;
      }
    } catch {
      // keep searching
    }
  }

  return null;
};

const runtimeError = (message: string, technicalCode: string): InstallAppResult => ({
  success: false,
  phase: 'failed',
  userMessage: message,
  technicalCode,
});

const emitInstallProgress = (appId: string, payload: InstallAppResult): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.installProgress, {
    appId,
    progress: payload,
  });
};

const emitRuntimeStatus = (payload: RuntimeStatus): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.runtimeStatusChanged, payload);
};

const emitChatRunUpdated = (payload: { run: unknown }): void => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send(IPC_CHANNELS.chatRunUpdated, payload);
};

const toAppSummary = (record: InstalledAppRecord): AppSummary => {
  const running = runningApps.get(record.appId);
  if (running) {
    return {
      id: record.appId,
      name: record.name,
      description: record.description,
      category: record.category,
      version: record.version,
      status: 'running',
      userMessage: 'En ejecucion',
    };
  }

  return {
    id: record.appId,
    name: record.name,
    description: record.description,
    category: record.category,
    version: record.version,
    status: record.status,
    userMessage: record.userMessage,
  };
};

const mapBackendCategory = (backendCategory: string): AppCategory => {
  switch (backendCategory) {
    case 'finance':
      return 'finanzas';
    case 'home':
      return 'hogar';
    case 'health':
      return 'salud';
    default:
      return 'productividad';
  }
};

const toCatalogStatus = (slug: string): AppStatus => {
  const installed = registry.apps[slug];
  if (!installed) {
    return 'not_installed';
  }
  return runningApps.has(slug) ? 'running' : installed.status;
};

const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (sessionToken) {
    headers.Authorization = `Bearer ${sessionToken}`;
  }

  return headers;
};

const readJson = async <T>(response: Response): Promise<T | null> => {
  const raw = await response.text();

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const normalizeToken = (value: string | undefined): string => {
  if (!value) {
    return '';
  }
  return value.trim().toLowerCase();
};

const ensurePathInside = (rootPath: string, targetPath: string): boolean => {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const resolveInstalledManifest = async (installDir: string): Promise<AppManifest | null> => {
  const manifestPath = path.join(installDir, 'manifest.json');
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as AppManifest;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const hasValidManifestStack = (manifest: AppManifest | null): manifest is AppManifest & { stack: AppManifestStack } => {
  if (!manifest?.stack || typeof manifest.stack !== 'object') {
    return false;
  }
  const backend = manifest.stack.backend && typeof manifest.stack.backend === 'object';
  const frontend = manifest.stack.frontend && typeof manifest.stack.frontend === 'object';
  return Boolean(backend || frontend);
};

const summarizeStack = (stack: AppManifestStack): string[] => {
  const lines: string[] = [];
  const backend = stack.backend;
  const frontend = stack.frontend;

  if (backend) {
    lines.push(
      `Backend: ${[
        backend.language && `lenguaje ${backend.language}`,
        backend.framework && `framework ${backend.framework}`,
        backend.package_manager && `gestor ${backend.package_manager}`,
        backend.database && `base de datos ${backend.database}`,
      ]
        .filter(Boolean)
        .join(', ') || 'no definido'}`,
    );
  }

  if (frontend) {
    lines.push(
      `Frontend: ${[
        frontend.language && `lenguaje ${frontend.language}`,
        frontend.framework && `framework ${frontend.framework}`,
        frontend.bundler && `bundler ${frontend.bundler}`,
        frontend.ui && `UI ${frontend.ui}`,
      ]
        .filter(Boolean)
        .join(', ') || 'no definido'}`,
    );
  }

  return lines;
};

const buildForgerAgentsMarkdown = (appId: string, manifest: AppManifest | null): string => {
  const stackLines = hasValidManifestStack(manifest) ? summarizeStack(manifest.stack) : [];
  const stackSection = stackLines.length > 0 ? stackLines.map((line) => `- ${line}`).join('\n') : '- No definido';
  const scriptEntries = manifest?.scripts ? Object.entries(manifest.scripts) : [];
  const scriptsSection =
    scriptEntries.length > 0
      ? scriptEntries.map(([name, command]) => `- ${name}: herramienta interna del agente. Comando declarado: \`${command}\``)
      : ['- No hay scripts declarados en `manifest.json`.'];

  return [
    '# AGENTS',
    '',
    FORGER_AGENT_CONTRACT_MARKER,
    '',
    '## Rol',
    `Eres Forger dentro de la app instalada \`${appId}\`. Ayudas al usuario a entender, usar y adaptar esta app sin inventar capacidades.`,
    '',
    '## Fuente de Verdad',
    '- Este `AGENTS.md` es la fuente principal de contexto funcional y operativo de la app.',
    '- `manifest.json` describe instalacion, servicios, stack y scripts disponibles; no es una lista de capacidades visibles para el usuario.',
    '- `.agents/skills` contiene playbooks internos del agente para tareas concretas.',
    '- Antes de responder o actuar, revisa este archivo, `manifest.json`, `.agents/skills` y los scripts declarados que correspondan a la tarea.',
    '',
    '## Capacidades visibles para el usuario',
    '- Si una app trae su propio `AGENTS.md`, las capacidades visibles deben estar documentadas ahi.',
    '- Si esta app solo tiene este archivo generado por Forger, no declares capacidades especificas sin revisar la UI, rutas, textos, modelos y servicios reales.',
    '- Una capacidad visible es algo que el usuario puede pedir o entender como una accion real de la app, por ejemplo revisar informacion, importar datos, corregir registros o ver un resumen.',
    '- No presentes scripts, rutas, comandos, endpoints, archivos temporales ni carpetas internas como capacidades visibles.',
    '- Si no encuentras evidencia suficiente para una capacidad, responde que no aparece como capacidad actual de la app.',
    '',
    '## Herramientas internas del agente',
    '- Las herramientas internas son recursos que puedes usar para cumplir una tarea: scripts, comandos, endpoints, skills, archivos temporales, consultas a base de datos o validaciones.',
    '- Estas herramientas no son instrucciones para el usuario final.',
    '- No le pidas al usuario que ubique archivos en carpetas internas, ejecute comandos, conozca rutas, prepare CSVs canonicos ni entienda detalles de base de datos.',
    '- Cuando uses una herramienta interna, traduce el resultado a lenguaje de producto: que se hizo, que cambio, que requiere revision y que puede hacer despues.',
    '- Si el usuario pregunta explicitamente por detalles tecnicos, entonces puedes explicar herramientas internas con claridad y separarlas de la experiencia normal de uso.',
    '',
    '## Scripts declarados como herramientas internas',
    ...scriptsSection,
    '',
    '## Stack de esta App',
    stackSection,
    '',
    '## Tareas Permitidas',
    '- resolver_dudas: investiga la app real antes de responder. Responde solo con capacidades verificadas.',
    '- trabajar_datos: usa el stack de datos establecido por la app. Revisa validaciones, modelos, endpoints y scripts antes de crear, editar o eliminar datos.',
    '- modificar_aplicacion: convierte el pedido en cambios concretos, pregunta alcance y casos borde si falta informacion, y explica impacto funcional sin mencionar implementacion salvo que el usuario lo pida.',
    '- interactuar_con_aplicacion: revisa scripts, skills y playbooks disponibles para saber que acciones internas puedes ejecutar por cuenta del usuario.',
    '',
    '## Comunicacion',
    '- Habla en lenguaje simple, pensado para usuario final.',
    '- Distingue siempre entre lo que la app puede hacer para el usuario y lo que tu puedes usar internamente para lograrlo.',
    '- No menciones implementacion, archivos, rutas, scripts, comandos ni detalles tecnicos salvo que el usuario lo pida.',
    '- Haz preguntas funcionales sobre objetivo, impacto, datos involucrados y alcance; evita preguntas de implementacion.',
    '- Si una tarea requiere un archivo, pide el archivo o los datos de forma natural. No pidas que lo pongan en una ruta interna.',
    '',
    '## Guardrails',
    '- Evita eliminaciones masivas accidentales de datos o archivos.',
    '- Antes de operaciones riesgosas o irreversibles, confirma la intencion funcional y propone una alternativa segura.',
    '- No uses archivos externos no compartidos explicitamente por el usuario.',
    '',
    '## Skills',
    '- Las skills de esta app estan en `.agents/skills`; revisalas cuando puedan ayudar.',
    '- Los scripts declarados en `manifest.json` son la interfaz preferida para acciones rutinarias.',
  ].join('\n');
};

const buildGlobalForgerAgentsMarkdown = (): string => {
  return [
    '# AGENTS',
    '',
    FORGER_AGENT_CONTRACT_MARKER,
    '',
    '## Rol',
    'Forger ayuda exclusivamente con aplicaciones instaladas en Forger. Tu trabajo es ayudar al usuario a entender, usar, adaptar e interactuar con esas apps, sin inventar capacidades y sin exponer detalles internos innecesarios.',
    '',
    '## Dominio Estricto',
    '- El workspace base es `~/Forger/apps`.',
    '- Solo puedes responder, preguntar o actuar sobre apps instaladas en este workspace.',
    '- Si el usuario pregunta algo fuera de una app instalada, responde brevemente que solo puedes ayudar con apps instaladas en Forger.',
    '- La app seleccionada es el foco principal. Usa otras apps solo si el usuario las menciona o el pedido lo requiere claramente.',
    '- No actues como consultor generico del dominio de la app. Por ejemplo, si una app financiera no tiene bancos, alertas o inversiones, no recomiendes configurar bancos, alertas o inversiones como si existieran.',
    '',
    '## Fuente de Verdad',
    '- El `AGENTS.md` de cada app es la fuente principal de contexto funcional y operativo.',
    '- `manifest.json` describe instalacion, servicios, stack y scripts. No lo trates como una lista de funciones visibles para el usuario.',
    '- `.agents/skills` contiene habilidades internas del agente para tareas concretas.',
    '- Los scripts declarados en `manifest.json` o documentados en la app son herramientas internas del agente, salvo que `AGENTS.md` diga explicitamente que son parte de la interfaz visible.',
    '',
    '## Antes de Responder',
    '- Identifica la app o apps involucradas.',
    '- Lee primero la documentacion y metadatos reales de la app: `AGENTS.md`, `manifest.json`, `.agents/skills` y scripts declarados.',
    '- Clasifica internamente la solicitud como una de estas tareas: resolver_dudas, trabajar_datos, modificar_aplicacion, interactuar_con_aplicacion.',
    '- Nunca asumas capacidades de una app. Verifica en sus archivos antes de afirmar que puede hacer algo.',
    '- Usa skills o scripts disponibles cuando existan.',
    '- Si la pregunta es sobre que puede hacer la app, responde solo con capacidades visibles verificadas, no con herramientas internas.',
    '',
    '## Capacidades visibles vs herramientas internas',
    '- Una capacidad visible es algo que el usuario puede pedir o entender como accion real de la app: revisar datos, cargar informacion, corregir clasificaciones, ver resumenes, ajustar configuracion visible.',
    '- Una herramienta interna es algo que tu puedes usar para cumplir la tarea: scripts, comandos, endpoints, carpetas temporales, archivos CSV intermedios, consultas de base de datos, skills o validaciones.',
    '- No le digas al usuario que ejecute scripts, ponga archivos en carpetas internas, cree CSVs canonicos, use rutas del proyecto o conozca comandos, salvo que pregunte explicitamente por detalles tecnicos.',
    '- Si usas herramientas internas, traduce la accion a lenguaje de producto. Ejemplo: di "puedo cargar los movimientos desde el archivo que compartas", no "pon el CSV en backend/scripts/data y correre import_movements.py".',
    '- Si una herramienta interna falla, explica el problema en terminos de usuario: filas rechazadas, datos incompletos, categorias no encontradas, formato invalido, accion no segura.',
    '',
    '## Tareas Permitidas',
    '- resolver_dudas: investiga la app antes de responder dudas. Si no hay evidencia, dilo con claridad.',
    '- trabajar_datos: trabaja con el stack de datos establecido por la app. Protege consistencia, respeta validaciones y evita borrados masivos.',
    '- modificar_aplicacion: convierte la solicitud en cambios concretos y pregunta alcance o casos borde si falta informacion.',
    '- interactuar_con_aplicacion: revisa scripts, skills y playbooks expuestos por la app para ejecutar acciones internas por cuenta del usuario.',
    '',
    '## Comunicacion',
    '- Usar lenguaje simple para usuarios no tecnicos.',
    '- No mencionar implementacion, archivos, rutas ni detalles tecnicos salvo que el usuario lo pida.',
    '- Comunicar impacto funcional: que cambia para la persona usuaria.',
    '- Preguntar por intencion, datos, alcance y confirmacion funcional; no preguntar por comandos o implementacion.',
    '- Si el usuario pide algo ambiguo, ofrece opciones funcionales y seguras.',
    '',
    '## Seguridad',
    '- No ejecutar comandos destructivos ni revertir cambios del usuario sin instruccion explicita.',
    '- No usar archivos externos no compartidos explicitamente por el usuario.',
    '- Antes de operaciones riesgosas o irreversibles, confirmar intencion funcional y proponer alternativa segura.',
  ].join('\n');
};

const ensureGlobalAgentsContext = async (privateAppsRoot: string): Promise<void> => {
  await fs.mkdir(privateAppsRoot, { recursive: true });
  const agentsPath = path.join(privateAppsRoot, 'AGENTS.md');
  await fs.writeFile(agentsPath, buildGlobalForgerAgentsMarkdown(), 'utf8');
};

const shouldWriteAppAgentsMarkdown = async (agentsPath: string): Promise<boolean> => {
  const current = await fs.readFile(agentsPath, 'utf8').catch(() => null);
  if (current === null) {
    return true;
  }

  if (!current.includes(FORGER_AGENT_CONTRACT_MARKER_PREFIX)) {
    return false;
  }

  return !current.includes(FORGER_AGENT_CONTRACT_MARKER);
};

const buildStackSkillTemplates = (stack: AppManifestStack): StackSkillTemplate[] => {
  const templates: StackSkillTemplate[] = [];
  const backend = stack.backend ?? {};
  const frontend = stack.frontend ?? {};
  const backendLanguage = normalizeToken(backend.language);
  const backendFramework = normalizeToken(backend.framework);
  const frontendFramework = normalizeToken(frontend.framework);
  const frontendUi = normalizeToken(frontend.ui);

  if (backendLanguage === 'python') {
    templates.push({
      id: 'forger-python-backend',
      description: 'Buenas prácticas para backend Python en Forger.',
      body: [
        '---',
        'name: forger-python-backend',
        'description: Usa cambios pequeños y seguros en backend Python, con foco en validaciones e integridad.',
        '---',
        '',
        '- Mantén validaciones del dominio antes de persistir.',
        '- Evita romper compatibilidad de payloads sin avisar impacto.',
        '- Prefiere cambios claros, testeables y fáciles de revertir.',
      ].join('\n'),
    });
  }

  if (backendFramework === 'fastapi') {
    templates.push({
      id: 'forger-fastapi-contracts',
      description: 'Guía para contratos y seguridad en endpoints FastAPI.',
      body: [
        '---',
        'name: forger-fastapi-contracts',
        'description: Ajusta rutas FastAPI respetando contratos y respuestas consistentes para usuarios no técnicos.',
        '---',
        '',
        '- Mantén semántica HTTP consistente.',
        '- No elimines campos de respuesta usados por frontend sin plan de migración.',
        '- Responde errores con mensajes claros y accionables.',
      ].join('\n'),
    });
  }

  if (frontendFramework === 'react') {
    templates.push({
      id: 'forger-react-ui',
      description: 'Buenas prácticas de UI React para usuarios no técnicos.',
      body: [
        '---',
        'name: forger-react-ui',
        'description: Prioriza flujos claros de vista previa, aplicar y deshacer en interfaces React.',
        '---',
        '',
        '- Usa textos simples y orientados a la acción.',
        '- Evita estados ambiguos; muestra claramente éxito, error y próximos pasos.',
        '- Mantén componentes predecibles y fáciles de extender.',
      ].join('\n'),
    });
  }

  if (frontendUi === 'mui') {
    templates.push({
      id: 'forger-mui-consistency',
      description: 'Consistencia visual y accesibilidad en MUI.',
      body: [
        '---',
        'name: forger-mui-consistency',
        'description: Usa patrones MUI consistentes para mantener una experiencia estable.',
        '---',
        '',
        '- Reutiliza componentes de MUI antes de crear variantes ad hoc.',
        '- Mantén jerarquía visual simple y mensajes fáciles de entender.',
        '- No introduzcas estilos que dificulten mantenimiento.',
      ].join('\n'),
    });
  }

  return templates;
};

const copyDirectory = async (sourceDir: string, targetDir: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
};

const writeStackSkills = async (skillsRoot: string, stack: AppManifestStack): Promise<void> => {
  const templates = buildStackSkillTemplates(stack);
  for (const template of templates) {
    const targetDir = path.join(skillsRoot, template.id);
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, 'SKILL.md'), template.body, 'utf8');
    await fs.writeFile(path.join(targetDir, 'README.md'), `${template.description}\n`, 'utf8');
  }
};

const copyAppSkills = async (installDir: string, skillsRoot: string, manifest: AppManifest): Promise<void> => {
  const declared = Array.isArray(manifest.skills) ? manifest.skills : [];
  const resolvedInstallDir = await fs.realpath(installDir);

  for (const entry of declared) {
    if (typeof entry !== 'string' || !entry.trim()) {
      continue;
    }
    const sourcePath = path.resolve(installDir, entry);
    const sourcePathReal = await fs.realpath(sourcePath).catch(() => null);
    if (!sourcePathReal || !ensurePathInside(resolvedInstallDir, sourcePathReal)) {
      continue;
    }

    const stat = await fs.stat(sourcePathReal).catch(() => null);
    if (!stat?.isDirectory()) {
      continue;
    }

    const skillName = path.basename(sourcePathReal);
    const destinationPath = path.join(skillsRoot, skillName);
    await copyDirectory(sourcePathReal, destinationPath);
  }
};

const normalizeInstalledAgentContext = async (installDir: string, appId: string): Promise<void> => {
  const manifest = await resolveInstalledManifest(installDir);

  const agentsPath = path.join(installDir, 'AGENTS.md');
  if (await shouldWriteAppAgentsMarkdown(agentsPath)) {
    await fs.writeFile(agentsPath, buildForgerAgentsMarkdown(appId, manifest), 'utf8');
  }

  const hasStack = hasValidManifestStack(manifest);
  const hasAppSkills = Boolean(manifest && Array.isArray(manifest.skills) && manifest.skills.length > 0);
  if (!hasStack && !hasAppSkills) {
    return;
  }

  const skillsRoot = path.join(installDir, '.agents', 'skills');
  await fs.rm(skillsRoot, { recursive: true, force: true });
  await fs.mkdir(skillsRoot, { recursive: true });
  if (hasStack) {
    await writeStackSkills(skillsRoot, manifest.stack);
  }
  if (manifest) {
    await copyAppSkills(installDir, skillsRoot, manifest);
  }
};

const resolveSelectedAppDisplayName = (appId: string): string => {
  const installedName = registry.apps[appId]?.name?.trim();
  if (installedName) {
    return installedName;
  }
  const catalogName = catalogApps.find((entry) => entry.id === appId)?.name?.trim();
  if (catalogName) {
    return catalogName;
  }
  return appId;
};

const buildCodexPromptWithAppContext = (appId: string, userPrompt: string): string => {
  const displayName = resolveSelectedAppDisplayName(appId);
  return [
    `APP SELECCIONADA: /${appId}`,
    `NOMBRE APP SELECCIONADA: ${displayName}`,
    `CONTRATO FORGER: ${FORGER_AGENT_CONTRACT_VERSION}`,
    '',
    'Instruccion operativa: sigue el contrato de Forger en AGENTS.md. Clasifica internamente la solicitud en una de las 4 tareas permitidas y revisa el contexto real de la app antes de responder.',
    '',
    'MENSAJE USUARIO:',
    userPrompt.trim(),
  ].join('\n');
};

const listCatalogFromBackend = async (): Promise<CatalogApp[]> => {
  type PublicCatalogResponseItem = {
    slug: string;
    name: string;
    short_description?: string | null;
    description?: string | null;
    category: string;
    latest_version?: {
      version?: string;
      required_python_version?: string | null;
      required_node_version?: string | null;
      checksum_sha256?: string | null;
      download_url?: string | null;
    };
  };

  try {
    const publicResponse = await fetch(catalogJsonUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (publicResponse.ok) {
      const publicPayload = await readJson<PublicCatalogResponseItem[]>(publicResponse);
      if (Array.isArray(publicPayload) && publicPayload.length > 0) {
        return publicPayload.map((appEntry) => ({
          id: appEntry.slug,
          category: mapBackendCategory(appEntry.category),
          status: toCatalogStatus(appEntry.slug),
          name: appEntry.name,
          description: appEntry.short_description ?? appEntry.description ?? '',
          latestVersion: appEntry.latest_version?.version,
          requiredPythonVersion: appEntry.latest_version?.required_python_version ?? undefined,
          requiredNodeVersion: appEntry.latest_version?.required_node_version ?? undefined,
          checksumSha256: appEntry.latest_version?.checksum_sha256 ?? undefined,
          downloadUrl: appEntry.latest_version?.download_url ?? undefined,
          version: appEntry.latest_version?.version,
          userMessage: registry.apps[appEntry.slug]?.userMessage,
        }));
      }
    }
  } catch {
    // Fallback to backend catalog API below.
  }

  const response = await fetch(`${backendBaseUrl}/api/v1/catalog/apps`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  if (!response.ok) {
    throw new Error(`catalog_request_failed_${response.status}`);
  }

  type CatalogResponseItem = {
    slug: string;
    name: string;
    short_description: string | null;
    description: string | null;
    category: string;
    latest_version?: {
      id: number;
      version: string;
      required_python_version?: string | null;
      required_node_version?: string | null;
      checksum_sha256?: string | null;
    };
  };

  const payload = await readJson<CatalogResponseItem[]>(response);
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.map((appEntry) => {
    return {
      id: appEntry.slug,
      category: mapBackendCategory(appEntry.category),
      status: toCatalogStatus(appEntry.slug),
      name: appEntry.name,
      description: appEntry.short_description ?? appEntry.description ?? '',
      latestVersionId: appEntry.latest_version?.id,
      latestVersion: appEntry.latest_version?.version,
      requiredPythonVersion: appEntry.latest_version?.required_python_version ?? undefined,
      requiredNodeVersion: appEntry.latest_version?.required_node_version ?? undefined,
      checksumSha256: appEntry.latest_version?.checksum_sha256 ?? undefined,
      version: appEntry.latest_version?.version,
      userMessage: registry.apps[appEntry.slug]?.userMessage,
    };
  });
};

const savePersistedSession = async (session: PersistedSession): Promise<void> => {
  const sessionPath = getSessionPath();
  await fs.mkdir(path.dirname(sessionPath), { recursive: true });
  await fs.writeFile(sessionPath, JSON.stringify(session, null, 2), 'utf8');
};

const clearPersistedSession = async (): Promise<void> => {
  await fs.rm(getSessionPath(), { force: true });
};

const loadPersistedSession = async (): Promise<void> => {
  try {
    const raw = await fs.readFile(getSessionPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedSession>;
    const maybeUser = parsed?.user;
    if (
      typeof parsed?.token === 'string' &&
      parsed.token &&
      maybeUser &&
      typeof maybeUser.id === 'number' &&
      typeof maybeUser.email === 'string'
    ) {
      sessionToken = parsed.token;
      sessionUser = {
        id: maybeUser.id,
        email: maybeUser.email,
      };
      settings = {
        ...settings,
        userEmail: maybeUser.email,
      };
      return;
    }
  } catch {
    // no-op
  }

  sessionToken = null;
  sessionUser = null;
};

const applyAuthenticatedSession = async (user: SessionUser, token: string): Promise<SessionState> => {
  sessionToken = token;
  sessionUser = user;
  settings = {
    ...settings,
    userEmail: user.email,
  };
  await savePersistedSession({ token, user });

  return {
    authenticated: true,
    user,
  };
};

const clearSession = async (): Promise<SessionState> => {
  sessionToken = null;
  sessionUser = null;
  settings = {
    ...settings,
    userEmail: '',
  };
  await clearPersistedSession();

  return { authenticated: false };
};

const resolveSession = async (): Promise<SessionState> => {
  if (!sessionToken) {
    return { authenticated: false };
  }

  const response = await fetch(`${backendBaseUrl}/api/v1/session`, {
    method: 'GET',
    headers: buildHeaders(),
  });

  if (response.status === 401) {
    return await clearSession();
  }

  if (!response.ok) {
    return {
      authenticated: false,
      error: `session_request_failed_${response.status}`,
    };
  }

  type SessionResponse = {
    authenticated: true;
    user: SessionUser;
  };

  const payload = await readJson<SessionResponse>(response);
  if (!payload || payload.authenticated !== true) {
    return await clearSession();
  }

  sessionUser = payload.user;
  settings = {
    ...settings,
    userEmail: payload.user.email,
  };
  await savePersistedSession({ token: sessionToken, user: payload.user });

  return {
    authenticated: true,
    user: payload.user,
  };
};

const loadRegistry = async (): Promise<void> => {
  const registryPath = getRegistryPath();

  try {
    const raw = await fs.readFile(registryPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppRegistry>;
    if (parsed && parsed.apps && typeof parsed.apps === 'object') {
      registry = { apps: parsed.apps as Record<string, InstalledAppRecord> };
      return;
    }
  } catch {
    // no-op
  }

  registry = { apps: {} };
};

const saveRegistry = async (): Promise<void> => {
  const registryPath = getRegistryPath();
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
};

const upsertInstalledRecord = async (record: InstalledAppRecord): Promise<void> => {
  registry.apps[record.appId] = record;
  await saveRegistry();
  emitRuntimeStatus({
    appId: record.appId,
    status: runningApps.has(record.appId) ? 'running' : record.status,
    userMessage: record.userMessage,
    backendUrl: runningApps.get(record.appId)?.backendUrl,
    frontendUrl: runningApps.get(record.appId)?.frontendUrl,
  });
};

const removeInstalledRecord = async (appId: string): Promise<void> => {
  delete registry.apps[appId];
  await saveRegistry();
};

const ensureCatalogStatuses = (): void => {
  catalogApps = catalogApps.map((appEntry) => {
    const installed = registry.apps[appEntry.id];
    const running = runningApps.has(appEntry.id);

    return {
      ...appEntry,
      status: installed ? (running ? 'running' : installed.status) : 'not_installed',
      userMessage: installed?.userMessage,
      version: installed?.version ?? appEntry.version,
    };
  });
};

const hashFileSha256 = async (filePath: string): Promise<string> => {
  const content = await fs.readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
};

const runCommand = async (
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      stdio: 'pipe',
    });

    let stderr = '';
    let stdout = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`command_failed_${code}: ${stdout}\n${stderr}`));
    });
  });
};

const canRunCommand = async (command: string, args: string[]): Promise<boolean> => {
  try {
    await runCommand(command, args, {
      cwd: app.getPath('userData'),
    });
    return true;
  } catch {
    return false;
  }
};

const ensureGitAvailable = async (): Promise<void> => {
  if (await canRunCommand('git', ['--version'])) {
    return;
  }

  if (process.platform === 'darwin') {
    if (await canRunCommand('brew', ['--version'])) {
      await runCommand('brew', ['install', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    }
  } else if (process.platform === 'win32') {
    if (await canRunCommand('winget', ['--version'])) {
      await runCommand(
        'winget',
        ['install', '--id', 'Git.Git', '-e', '--accept-package-agreements', '--accept-source-agreements'],
        { cwd: app.getPath('userData') },
      ).catch(() => undefined);
    }
  } else {
    if (await canRunCommand('apt-get', ['--version'])) {
      await runCommand('apt-get', ['update'], { cwd: app.getPath('userData') }).catch(() => undefined);
      await runCommand('apt-get', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('dnf', ['--version'])) {
      await runCommand('dnf', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('yum', ['--version'])) {
      await runCommand('yum', ['install', '-y', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    } else if (await canRunCommand('apk', ['--version'])) {
      await runCommand('apk', ['add', 'git'], { cwd: app.getPath('userData') }).catch(() => undefined);
    }
  }

  if (!(await canRunCommand('git', ['--version']))) {
    throw new Error('git_unavailable');
  }
};

const ensureGitMainBranch = async (cwd: string): Promise<void> => {
  await runCommand('git', ['checkout', 'main'], { cwd }).catch(async () => {
    await runCommand('git', ['checkout', '-B', 'main'], { cwd });
  });
};

const ensureAppGitRepository = async (cwd: string): Promise<void> => {
  await ensureGitAvailable();

  const isRepo = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd })
    .then(() => true)
    .catch(() => false);

  if (!isRepo) {
    await runCommand('git', ['init', '-b', 'main'], { cwd }).catch(async () => {
      await runCommand('git', ['init'], { cwd });
      await ensureGitMainBranch(cwd);
    });
    await runCommand('git', ['config', 'user.email', 'forger@local.invalid'], { cwd }).catch(() => undefined);
    await runCommand('git', ['config', 'user.name', 'Forger'], { cwd }).catch(() => undefined);
    await runCommand('git', ['add', '-A'], { cwd }).catch(() => undefined);
    await runCommand('git', ['commit', '--allow-empty', '-m', 'forger: initial state'], { cwd }).catch(
      () => undefined,
    );
    return;
  }

  await runCommand('git', ['config', 'user.email', 'forger@local.invalid'], { cwd }).catch(() => undefined);
  await runCommand('git', ['config', 'user.name', 'Forger'], { cwd }).catch(() => undefined);
  await ensureGitMainBranch(cwd);
};

const clearMacQuarantine = async (targetPath: string): Promise<void> => {
  if (process.platform !== 'darwin') {
    return;
  }

  try {
    await fs.access(targetPath);
  } catch {
    return;
  }

  await runCommand('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', targetPath], {
    cwd: path.dirname(targetPath),
  }).catch(() => {
    // Best effort: if no xattr is present we can continue.
  });
};

const extractArchive = async (archivePath: string, destination: string): Promise<void> => {
  await fs.mkdir(destination, { recursive: true });

  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      await runCommand(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
        ],
        { cwd: destination },
      );
      return;
    }

    await runCommand('unzip', ['-q', archivePath, '-d', destination], { cwd: destination });
    return;
  }

  if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    await runCommand('tar', ['-xzf', archivePath, '-C', destination], { cwd: destination });
    return;
  }

  throw new Error(`unsupported_archive_format_${archivePath}`);
};

const flattenSingleTopLevelDirectory = async (targetDir: string): Promise<void> => {
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !entry.name.startsWith('.'));

  if (visibleEntries.length !== 1 || !visibleEntries[0].isDirectory()) {
    return;
  }

  const topFolder = path.join(targetDir, visibleEntries[0].name);
  const children = await fs.readdir(topFolder);
  for (const child of children) {
    await fs.rename(path.join(topFolder, child), path.join(targetDir, child));
  }
  await fs.rm(topFolder, { recursive: true, force: true });
};

const normalizeVersionForFolder = (value: string): string => {
  const [major, minor] = value.split('.');
  if (major && minor) {
    return `${major}.${minor}`;
  }
  return value;
};

const findExistingFile = async (baseDir: string, candidates: string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    const attempt = path.join(baseDir, candidate);

    try {
      const stat = await fs.stat(attempt);
      if (stat.isFile()) {
        return attempt;
      }
    } catch {
      // keep searching
    }
  }

  return null;
};

const resolveRuntimeExecutables = async (runtimeRoot: string, type: 'node' | 'python'): Promise<RuntimeBinarySet> => {
  const root = runtimeRoot;

  if (type === 'node') {
    const node = await findExistingFile(root, [
      path.join('bin', 'node'),
      'node.exe',
      path.join('node', 'bin', 'node'),
      path.join('node', 'node.exe'),
    ]);
    const npm = await findExistingFile(root, [
      path.join('bin', 'npm'),
      path.join('bin', 'npm.cmd'),
      'npm.cmd',
      path.join('node', 'bin', 'npm'),
      path.join('node', 'npm.cmd'),
    ]);

    if (!node || !npm) {
      throw new Error('runtime_node_executable_not_found');
    }

    return {
      rootDir: root,
      node,
      npm,
    };
  }

  const python = await findExistingFile(root, [
    path.join('bin', 'python3'),
    path.join('bin', 'python'),
    'python.exe',
    path.join('python', 'bin', 'python3'),
    path.join('python', 'bin', 'python'),
    path.join('python', 'python.exe'),
  ]);
  const pip = await findExistingFile(root, [
    path.join('bin', 'pip3'),
    path.join('bin', 'pip'),
    'pip.exe',
    path.join('python', 'bin', 'pip3'),
    path.join('python', 'bin', 'pip'),
    path.join('python', 'pip.exe'),
  ]);

  if (!python || !pip) {
    throw new Error('runtime_python_executable_not_found');
  }

  return {
    rootDir: root,
    python,
    pip,
  };
};

const ensureRuntimeInstalled = async (
  type: 'node' | 'python',
  rawVersion: string,
): Promise<RuntimeBinarySet> => {
  const platformAlias = resolvePlatformAlias();
  if (!RUNTIME_PLATFORM_ALIASES.has(platformAlias)) {
    throw new Error(`unsupported_platform_${platformAlias}`);
  }

  const version = normalizeVersionForFolder(rawVersion);
  const lockKey = `${type}:${version}:${platformAlias}`;
  const pending = runtimeLocks.get(lockKey);
  if (pending) {
    return pending;
  }

  const task = (async () => {
    const targetRoot = path.join(getRuntimesRoot(), type, version, platformAlias);
    const readyPath = path.join(targetRoot, '.ready');

    try {
      await fs.access(readyPath);
      await clearMacQuarantine(targetRoot);
      return await resolveRuntimeExecutables(targetRoot, type);
    } catch {
      // continue with extraction
    }

    const resourcesRoot = getBundledResourcesRoot();
    const runtimeVersionDir = path.join(resourcesRoot, type, version);
    const runtimeArchive = await findRuntimeArchive(runtimeVersionDir, platformAlias);

    if (!runtimeArchive) {
      throw new Error(`runtime_archive_missing_${type}_${version}_${platformAlias}`);
    }

    try {
      const runtimeChecksumFile = await findRuntimeChecksumFile(runtimeVersionDir, runtimeArchive, platformAlias);
      if (runtimeChecksumFile) {
        const checksumRaw = await fs.readFile(runtimeChecksumFile, 'utf8');
        const expected = checksumRaw.trim().split(/\s+/)[0];
        if (expected) {
          const current = await hashFileSha256(runtimeArchive);
          if (current !== expected) {
            throw new Error(`runtime_checksum_mismatch_${type}_${version}_${platformAlias}`);
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('runtime_checksum_mismatch')) {
        throw error;
      }
      // Missing checksum file is tolerated in dev mode.
    }

    const tempDir = path.join(getTempRoot(), `${type}-${version}-${platformAlias}-${Date.now()}`);
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    await extractArchive(runtimeArchive, tempDir);
    await flattenSingleTopLevelDirectory(tempDir);

    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    await fs.rename(tempDir, targetRoot);
    await fs.writeFile(readyPath, new Date().toISOString(), 'utf8');
    await clearMacQuarantine(targetRoot);

    return await resolveRuntimeExecutables(targetRoot, type);
  })();

  runtimeLocks.set(lockKey, task);

  try {
    return await task;
  } finally {
    runtimeLocks.delete(lockKey);
  }
};

const shellQuote = (value: string): string => {
  return `'${value.replace(/'/g, `'\\''`)}'`;
};

const getCodexAuthFilePath = (): string => path.join(getCodexHome(), 'auth.json');

const resolveCodexCliPath = async (baseDir: string): Promise<string | null> => {
  return await findExistingFile(baseDir, [
    path.join('node_modules', '.bin', 'codex'),
    path.join('node_modules', '.bin', 'codex.cmd'),
  ]);
};

const ensureCodexCliInstalled = async (): Promise<string> => {
  const existing = await resolveCodexCliPath(getCodexRoot());
  if (existing) {
    return existing;
  }

  const nodeRuntime = await ensureRuntimeInstalled('node', DEFAULT_NODE_VERSION);
  const codexRoot = getCodexRoot();
  await fs.mkdir(codexRoot, { recursive: true });

  const packageJsonPath = path.join(codexRoot, 'package.json');
  try {
    await fs.access(packageJsonPath);
  } catch {
    await fs.writeFile(
      packageJsonPath,
      JSON.stringify(
        {
          name: 'forger-codex-runtime',
          private: true,
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  await runCommand(
    nodeRuntime.npm as string,
    ['install', '--no-audit', '--no-fund', `@openai/codex@${CODEX_CLI_VERSION}`],
    {
    cwd: codexRoot,
    env: {
      PATH: `${path.dirname(nodeRuntime.node as string)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    },
  );

  const installed = await resolveCodexCliPath(codexRoot);
  if (!installed) {
    throw new Error('codex_cli_install_failed');
  }

  return installed;
};

const getCodexAuthStatus = async (): Promise<CodexAuthStatus> => {
  const authFilePath = getCodexAuthFilePath();
  const codexHome = getCodexHome();
  const codexCliPath = await resolveCodexCliPath(getCodexRoot());

  let authenticated = false;
  try {
    const raw = await fs.readFile(authFilePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    authenticated = Boolean(parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0);
  } catch {
    authenticated = false;
  }

  return {
    installed: Boolean(codexCliPath),
    authenticated,
    authFilePath,
    codexHome,
    codexCliPath: codexCliPath ?? undefined,
  };
};

const connectCodexAuth = async (): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> => {
  try {
    const codexCliPath = await ensureCodexCliInstalled();
    const codexHome = getCodexHome();
    await fs.mkdir(codexHome, { recursive: true });

    if (process.platform === 'darwin') {
      const loginCommand = `export CODEX_HOME=${shellQuote(codexHome)}; ${shellQuote(codexCliPath)} login`;
      await runCommand(
        '/usr/bin/osascript',
        [
          '-e',
          'tell application "Terminal"',
          '-e',
          'activate',
          '-e',
          `do script ${JSON.stringify(loginCommand)}`,
          '-e',
          'end tell',
        ],
        { cwd: app.getPath('userData') },
      );

      return {
        success: true,
        userMessage: 'Abrimos Terminal para completar el login de Codex con ChatGPT.',
      };
    }

    await runCommand(codexCliPath, ['login'], {
      cwd: app.getPath('userData'),
      env: {
        CODEX_HOME: codexHome,
      },
    });

    return {
      success: true,
      userMessage: 'Login de Codex completado.',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'codex_auth_failed';
    return {
      success: false,
      userMessage: 'No pudimos iniciar el login de Codex.',
      technicalCode: detail,
    };
  }
};

const disconnectCodexAuth = async (): Promise<{ success: boolean; userMessage: string; technicalCode?: string }> => {
  try {
    await fs.rm(getCodexAuthFilePath(), { force: true });
    return {
      success: true,
      userMessage: 'Sesion de Codex desconectada.',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'codex_logout_failed';
    return {
      success: false,
      userMessage: 'No pudimos cerrar la sesion de Codex.',
      technicalCode: detail,
    };
  }
};

const fetchDownloadBundle = async (
  appEntry: CatalogApp,
): Promise<{ zipPath: string; version: string; checksumSha256?: string }> => {
  type DownloadPayload = {
    download_url: string;
    version: {
      version: string;
      checksum_sha256?: string | null;
    };
  };

  let downloadUrl = appEntry.downloadUrl;
  let resolvedVersion = appEntry.latestVersion;
  let expectedChecksum = appEntry.checksumSha256;

  if (!downloadUrl) {
    if (!sessionToken) {
      throw new Error('auth_required');
    }

    if (!appEntry.latestVersionId) {
      throw new Error('latest_version_not_found');
    }

    const platform = resolvePlatformAlias();

    const response = await fetch(`${backendBaseUrl}/api/v1/app_versions/${appEntry.latestVersionId}/download`, {
      method: 'POST',
      headers: {
        ...buildHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        platform,
        device_identifier: os.hostname(),
      }),
    });

    if (!response.ok) {
      throw new Error(`download_request_failed_${response.status}`);
    }

    const payload = await readJson<DownloadPayload>(response);
    if (!payload?.download_url || !payload.version?.version) {
      throw new Error('download_payload_invalid');
    }

    downloadUrl = payload.download_url;
    resolvedVersion = payload.version.version;
    expectedChecksum = payload.version.checksum_sha256 ?? expectedChecksum;
  }

  const zipResponse = await fetch(downloadUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/zip',
    },
  });

  if (!zipResponse.ok) {
    throw new Error(`download_blob_failed_${zipResponse.status}`);
  }

  const arrayBuffer = await zipResponse.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const zipPath = path.join(getTempRoot(), `${appEntry.id}-${Date.now()}.zip`);
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.writeFile(zipPath, buffer);

  if (expectedChecksum) {
    const actual = createHash('sha256').update(buffer).digest('hex');
    if (actual !== expectedChecksum) {
      throw new Error('app_zip_checksum_mismatch');
    }
  }

  return {
    zipPath,
    version: resolvedVersion ?? '0.0.0',
    checksumSha256: expectedChecksum ?? undefined,
  };
};

const getVenvExecutables = (backendDir: string): { python: string; pip: string } => {
  if (process.platform === 'win32') {
    return {
      python: path.join(backendDir, '.venv', 'Scripts', 'python.exe'),
      pip: path.join(backendDir, '.venv', 'Scripts', 'pip.exe'),
    };
  }

  return {
    python: path.join(backendDir, '.venv', 'bin', 'python'),
    pip: path.join(backendDir, '.venv', 'bin', 'pip'),
  };
};

const installBackendDependenciesWithUv = async (
  pythonPath: string,
  backendDir: string,
): Promise<void> => {
  await runCommand(pythonPath, ['-m', 'pip', 'install', '--upgrade', 'pip', 'uv'], {
    cwd: backendDir,
  });

  const lockPath = path.join(backendDir, 'uv.lock');
  const uvArgs = ['-m', 'uv', 'sync', '--no-install-project', '--no-dev'];

  try {
    await fs.access(lockPath);
    uvArgs.push('--frozen');
  } catch {
    // Without uv.lock, we still sync from pyproject.
  }

  await runCommand(pythonPath, uvArgs, {
    cwd: backendDir,
    env: {
      UV_PROJECT_ENVIRONMENT: path.join(backendDir, '.venv'),
      UV_PYTHON: pythonPath,
    },
  });
};

const installAppRuntime = async (appId: string): Promise<InstallAppResult> => {
  const catalogApp = catalogApps.find((entry) => entry.id === appId);
  if (!catalogApp) {
    return runtimeError('La app no esta disponible para instalar.', 'catalog_app_missing');
  }

  const initialRecord: InstalledAppRecord = {
    appId,
    category: catalogApp.category,
    name: catalogApp.name ?? appId,
    description: catalogApp.description ?? '',
    version: catalogApp.latestVersion ?? '0.0.0',
    installDir: '',
    requiredNodeVersion: DEFAULT_NODE_VERSION,
    requiredPythonVersion: DEFAULT_PYTHON_VERSION,
    status: 'installing',
    userMessage: 'Preparando instalacion...',
  };

  await upsertInstalledRecord(initialRecord);

  const publishProgress = async (phase: InstallAppResult['phase'], userMessage: string): Promise<void> => {
    emitInstallProgress(appId, {
      success: true,
      phase,
      userMessage,
    });

    const current = registry.apps[appId];
    if (current) {
      await upsertInstalledRecord({
        ...current,
        status: 'installing',
        userMessage,
      });
    }
  };

  try {
    await publishProgress('starting', 'Iniciando instalacion...');

    const nodeVersion = DEFAULT_NODE_VERSION;
    const pythonVersion = catalogApp.requiredPythonVersion
      ? normalizeVersionForFolder(catalogApp.requiredPythonVersion)
      : DEFAULT_PYTHON_VERSION;

    await publishProgress('downloading', 'Descargando app...');
    const download = await fetchDownloadBundle(catalogApp);

    const installRoot = path.join(getPrivateAppsRoot(), appId);
    const installDir = installRoot;
    await fs.mkdir(path.dirname(installRoot), { recursive: true });
    await fs.rm(installDir, { recursive: true, force: true });

    await publishProgress('extracting', 'Preparando archivos de la app...');
    await extractArchive(download.zipPath, installDir);
    await flattenSingleTopLevelDirectory(installDir);
    await clearMacQuarantine(installDir);
    await normalizeInstalledAgentContext(installDir, appId);
    await ensureGlobalAgentsContext(getPrivateAppsRoot());
    await ensureAppGitRepository(installDir);

    await publishProgress('preparing_runtime', 'Preparando runtimes compartidos...');
    const nodeRuntime = await ensureRuntimeInstalled('node', nodeVersion);
    const pythonRuntime = await ensureRuntimeInstalled('python', pythonVersion);

    const backendDir = path.join(installDir, 'backend');
    const frontendDir = path.join(installDir, 'frontend');

    await publishProgress('installing_backend', 'Instalando dependencias del backend con uv...');
    await installBackendDependenciesWithUv(pythonRuntime.python as string, backendDir);

    await publishProgress('installing_frontend', 'Instalando dependencias del frontend...');
    await runCommand(nodeRuntime.npm as string, ['install'], {
      cwd: frontendDir,
      env: {
        PATH: `${path.dirname(nodeRuntime.node as string)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    const installed: InstalledAppRecord = {
      appId,
      category: catalogApp.category,
      name: catalogApp.name ?? appId,
      description: catalogApp.description ?? '',
      version: download.version,
      installDir,
      requiredNodeVersion: nodeVersion,
      requiredPythonVersion: pythonVersion,
      status: 'installed',
      userMessage: 'Instalada y lista para abrir.',
    };
    await upsertInstalledRecord(installed);

    emitInstallProgress(appId, {
      success: true,
      phase: 'completed',
      userMessage: 'Instalacion completada.',
    });

    ensureCatalogStatuses();

    return {
      success: true,
      phase: 'completed',
      userMessage: 'Instalacion completada.',
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'install_failed_unknown';
    const current = registry.apps[appId];

    if (current) {
      await upsertInstalledRecord({
        ...current,
        status: 'error',
        userMessage: 'No se pudo instalar. Puedes reintentar.',
      });
    }

    emitInstallProgress(appId, {
      success: false,
      phase: 'failed',
      userMessage: 'No se pudo completar la instalacion. Reintenta.',
      technicalCode: detail,
    });

    ensureCatalogStatuses();

    return {
      success: false,
      phase: 'failed',
      userMessage: 'No se pudo completar la instalacion. Reintenta.',
      technicalCode: detail,
    };
  }
};

const waitForHttpOk = async (url: string, timeoutMs: number): Promise<void> => {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) {
        return;
      }
    } catch {
      // continue polling
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`startup_timeout_${url}`);
};

const getFreePort = async (): Promise<number> => {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        resolve(address.port);
      } else {
        reject(new Error('port_not_available'));
      }
      server.close();
    });
    server.on('error', reject);
  });
};

const terminateProcess = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.killed) {
    return;
  }

  if (process.platform === 'win32') {
    await runCommand('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      cwd: app.getPath('userData'),
    }).catch(() => {
      // best effort
    });
    return;
  }

  child.kill('SIGTERM');

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const markAppRuntimeStatus = async (
  appId: string,
  status: Exclude<AppStatus, 'not_installed'>,
  userMessage: string,
): Promise<void> => {
  const current = registry.apps[appId];
  if (!current) {
    return;
  }

  const nextStatus: Exclude<AppStatus, 'not_installed' | 'running'> = status === 'running' ? 'installed' : status;
  await upsertInstalledRecord({
    ...current,
    status: nextStatus,
    userMessage,
  });
  ensureCatalogStatuses();
};

const closeAppWindow = (appId: string): void => {
  const existing = appWindows.get(appId);
  appWindows.delete(appId);
  if (existing && !existing.isDestroyed()) {
    existing.close();
  }
};

const openOrFocusAppWindow = async (appId: string, appName: string, frontendUrl: string): Promise<void> => {
  const existing = appWindows.get(appId);
  if (existing && !existing.isDestroyed()) {
    if (existing.webContents.getURL() !== frontendUrl) {
      await existing.loadURL(frontendUrl).catch(() => {
        // keep current URL if reload fails
      });
    }
    if (existing.isMinimized()) {
      existing.restore();
    }
    existing.show();
    existing.focus();
    return;
  }

  const appWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#F6F3EE',
    title: appName,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  appWindows.set(appId, appWindow);
  appWindow.on('closed', () => {
    appWindows.delete(appId);
    if (!stoppingApps.has(appId) && runningApps.has(appId)) {
      void stopInstalledApp(appId);
    }
  });

  await appWindow.loadURL(frontendUrl);
};

const openInstalledApp = async (appId: string): Promise<OpenAppResult> => {
  const record = registry.apps[appId];
  if (!record || !record.installDir) {
    return {
      success: false,
      userMessage: 'Primero instala esta app.',
      technicalCode: 'app_not_installed',
    };
  }

  const running = runningApps.get(appId);
  if (running) {
    await openOrFocusAppWindow(appId, record.name, running.frontendUrl);
    return {
      success: true,
      userMessage: 'La app ya esta en ejecucion.',
      backendUrl: running.backendUrl,
      frontendUrl: running.frontendUrl,
    };
  }

  const nodeRuntime = await ensureRuntimeInstalled('node', record.requiredNodeVersion);
  await ensureRuntimeInstalled('python', record.requiredPythonVersion);

  const backendDir = path.join(record.installDir, 'backend');
  const frontendDir = path.join(record.installDir, 'frontend');
  const venv = getVenvExecutables(backendDir);

  const backendPort = await getFreePort();
  const frontendPort = await getFreePort();
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;

  const backend = spawn(
    venv.python,
    ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(backendPort), '--reload'],
    {
      cwd: backendDir,
      env: {
        ...process.env,
        CORS_ORIGINS: `${frontendUrl},http://127.0.0.1:${frontendPort}`,
      },
      stdio: 'pipe',
    },
  );

  const frontend = spawn(nodeRuntime.npm as string, ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(frontendPort)], {
    cwd: frontendDir,
    env: {
      ...process.env,
      VITE_API_BASE_URL: backendUrl,
      PATH: `${path.dirname(nodeRuntime.node as string)}${path.delimiter}${process.env.PATH ?? ''}`,
    },
    stdio: 'pipe',
  });

  const onProcessCrash = async (): Promise<void> => {
    if (stoppingApps.has(appId)) {
      return;
    }

    closeAppWindow(appId);
    await markAppRuntimeStatus(appId, 'error', 'La app se detuvo por un error. Inicia de nuevo.');
    emitRuntimeStatus({
      appId,
      status: 'error',
      userMessage: 'La app se detuvo por un error. Inicia de nuevo.',
    });

    runningApps.delete(appId);
  };

  backend.once('exit', () => {
    void onProcessCrash();
  });

  frontend.once('exit', () => {
    void onProcessCrash();
  });

  runningApps.set(appId, {
    appId,
    backend,
    frontend,
    backendUrl,
    frontendUrl,
  });

  try {
    await waitForHttpOk(`${backendUrl}/health`, 60_000);
    await waitForHttpOk(frontendUrl, 60_000);
    await openOrFocusAppWindow(appId, record.name, frontendUrl);

    await markAppRuntimeStatus(appId, 'running', 'App en ejecucion.');
    emitRuntimeStatus({
      appId,
      status: 'running',
      userMessage: 'App en ejecucion.',
      backendUrl,
      frontendUrl,
    });

    ensureCatalogStatuses();

    return {
      success: true,
      userMessage: 'App abierta correctamente.',
      backendUrl,
      frontendUrl,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'open_failed';

    await terminateProcess(backend);
    await terminateProcess(frontend);
    runningApps.delete(appId);
    closeAppWindow(appId);
    await markAppRuntimeStatus(appId, 'error', 'No pudimos iniciar la app. Reintenta.');

    return {
      success: false,
      userMessage: 'No pudimos iniciar la app. Reintenta.',
      technicalCode: detail,
    };
  }
};

const stopInstalledApp = async (appId: string): Promise<StopAppResult> => {
  const running = runningApps.get(appId);
  if (!running) {
    return {
      success: true,
      userMessage: 'La app ya estaba detenida.',
    };
  }

  stoppingApps.add(appId);
  try {
    closeAppWindow(appId);
    await terminateProcess(running.backend);
    await terminateProcess(running.frontend);
    runningApps.delete(appId);
  } finally {
    stoppingApps.delete(appId);
  }

  await markAppRuntimeStatus(appId, 'installed', 'App detenida.');
  emitRuntimeStatus({
    appId,
    status: 'installed',
    userMessage: 'App detenida.',
  });
  ensureCatalogStatuses();

  return {
    success: true,
    userMessage: 'App detenida correctamente.',
  };
};

const getRuntimeStatus = (appId: string): RuntimeStatus => {
  const running = runningApps.get(appId);
  const record = registry.apps[appId];

  if (running) {
    return {
      appId,
      status: 'running',
      userMessage: 'App en ejecucion.',
      backendUrl: running.backendUrl,
      frontendUrl: running.frontendUrl,
    };
  }

  if (!record) {
    return {
      appId,
      status: 'not_installed',
      userMessage: 'Aun no instalada.',
    };
  }

  return {
    appId,
    status: record.status,
    userMessage: record.userMessage,
  };
};

const findSqliteFile = async (searchDir: string): Promise<string | null> => {
  const extensions = ['.db', '.sqlite', '.sqlite3'];
  try {
    const entries = await fs.readdir(searchDir, { withFileTypes: true });
    const file = entries.find(
      (entry) => entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext)),
    );
    if (file) {
      return path.join(searchDir, file.name);
    }
  } catch {
    // directory may not exist
  }
  return null;
};

const resolveAppDbPath = async (appId: string): Promise<string | null> => {
  const record = registry.apps[appId];
  if (!record?.installDir) {
    return null;
  }
  const backendDir = path.join(record.installDir, 'backend');
  const found = await findSqliteFile(backendDir);
  if (found) {
    return found;
  }
  // Fallback: search one level deeper (e.g. backend/data/)
  try {
    const entries = await fs.readdir(backendDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const nested = await findSqliteFile(path.join(backendDir, entry.name));
        if (nested) {
          return nested;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
};

const createWindow = async (): Promise<void> => {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.js');

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: '#F6F3EE',
    title: isDev ? 'Forger Dev' : 'Forger',
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }
};

const registerIpcHandlers = (): void => {
  ipcMain.handle(IPC_CHANNELS.getSession, async () => {
    return resolveSession();
  });

  ipcMain.handle(IPC_CHANNELS.login, async (_event, email: string, password: string) => {
    let response: Response;

    try {
      response = await fetch(`${backendBaseUrl}/api/v1/session`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'network_error';
      return {
        authenticated: false,
        error: `backend_unreachable: ${detail}`,
      };
    }

    if (response.status === 401) {
      type InvalidCredentials = {
        authenticated: false;
        error: string;
      };

      const payload = await readJson<InvalidCredentials>(response);
      return {
        authenticated: false,
        error: payload?.error ?? 'invalid_credentials',
      };
    }

    if (!response.ok) {
      return {
        authenticated: false,
        error: `login_failed_${response.status}`,
      };
    }

    type CreateSessionResponse = {
      authenticated: true;
      user: SessionUser;
      token: string;
    };

    const payload = await readJson<CreateSessionResponse>(response);
    if (!payload || payload.authenticated !== true || !payload.token) {
      return {
        authenticated: false,
        error: 'invalid_login_response',
      };
    }

    return await applyAuthenticatedSession(payload.user, payload.token);
  });

  ipcMain.handle(IPC_CHANNELS.logout, async () => {
    if (!sessionToken) {
      return await clearSession();
    }

    try {
      await fetch(`${backendBaseUrl}/api/v1/session`, {
        method: 'DELETE',
        headers: buildHeaders(),
      });
    } catch {
      return await clearSession();
    }

    return await clearSession();
  });

  ipcMain.handle(IPC_CHANNELS.listInstalledApps, async () => {
    return Object.values(registry.apps).map(toAppSummary);
  });

  ipcMain.handle(IPC_CHANNELS.listCatalogApps, async () => {
    catalogApps = await listCatalogFromBackend();
    ensureCatalogStatuses();
    return catalogApps;
  });

  ipcMain.handle(IPC_CHANNELS.installApp, async (_event, appId: string) => {
    return await installAppRuntime(appId);
  });

  ipcMain.handle(IPC_CHANNELS.openApp, async (_event, appId: string) => {
    return await openInstalledApp(appId);
  });

  ipcMain.handle(IPC_CHANNELS.stopApp, async (_event, appId: string) => {
    return await stopInstalledApp(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getAppRuntimeStatus, async (_event, appId: string) => {
    return getRuntimeStatus(appId);
  });

  ipcMain.handle(IPC_CHANNELS.getSettings, async () => settings);
  ipcMain.handle(IPC_CHANNELS.getCodexAuthStatus, async () => await getCodexAuthStatus());
  ipcMain.handle(IPC_CHANNELS.connectCodexAuth, async () => await connectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.disconnectCodexAuth, async () => await disconnectCodexAuth());
  ipcMain.handle(IPC_CHANNELS.chatStartRun, async (_event, input: ChatStartRunInput) => {
    if (!chatOrchestrator) {
      return { runId: '', status: 'failed' };
    }
    const enrichedPrompt = buildCodexPromptWithAppContext(input.appId, input.prompt);
    return await chatOrchestrator.startRun({
      ...input,
      prompt: enrichedPrompt,
    });
  });
  ipcMain.handle(IPC_CHANNELS.chatGetRun, async (_event, input: ChatGetRunInput) => {
    if (!chatOrchestrator) {
      return null;
    }
    return chatOrchestrator.getRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatCancelRun, async (_event, input: ChatCancelRunInput) => {
    if (!chatOrchestrator) {
      return { success: false };
    }
    return chatOrchestrator.cancelRun(input);
  });
  ipcMain.handle(
    IPC_CHANNELS.chatApprovePermission,
    async (_event, input: ChatApprovePermissionInput) => {
      if (!chatOrchestrator) {
        return { success: false };
      }
      return chatOrchestrator.approvePermission(input);
    },
  );
  ipcMain.handle(IPC_CHANNELS.chatApplyRun, async (_event, input: ChatApplyRunInput) => {
    if (!chatOrchestrator) {
      return { success: false, technicalCode: 'chat_orchestrator_unavailable' };
    }
    return await chatOrchestrator.applyRun(input);
  });
  ipcMain.handle(IPC_CHANNELS.chatUndo, async (_event, input: ChatUndoInput) => {
    if (!chatOrchestrator) {
      return { success: false, technicalCode: 'chat_orchestrator_unavailable' };
    }
    return await chatOrchestrator.undo(input);
  });

  ipcMain.handle(IPC_CHANNELS.dbListTables, async (_event, appId: string) => {
    if (!BetterSqlite3) {
      return { error: 'db_module_unavailable' };
    }
    const dbPath = await resolveAppDbPath(appId);
    if (!dbPath) {
      return { error: 'db_file_not_found' };
    }
    try {
      const db = new BetterSqlite3(dbPath, { readonly: true });
      type SqliteMasterRow = { name: string };
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as SqliteMasterRow[];
      db.close();
      return { tables: rows.map((row) => row.name), dbPath };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'db_list_tables_failed';
      return { error: detail };
    }
  });

  ipcMain.handle(IPC_CHANNELS.dbQueryTable, async (_event, appId: string, tableName: string, limit = 1000) => {
    if (!BetterSqlite3) {
      return { error: 'db_module_unavailable' };
    }
    const dbPath = await resolveAppDbPath(appId);
    if (!dbPath) {
      return { error: 'db_file_not_found' };
    }
    try {
      const db = new BetterSqlite3(dbPath, { readonly: true });
      const safeName = tableName.replace(/"/g, '""');
      const stmt = db.prepare(`SELECT * FROM "${safeName}" LIMIT ?`);
      const rawRows = stmt.all(limit) as Record<string, unknown>[];
      const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : (stmt.columns().map((col) => col.name));
      const rows = rawRows.map((row) => columns.map((col) => row[col] ?? null));
      type CountRow = { total: number };
      const countRow = db.prepare(`SELECT COUNT(*) as total FROM "${safeName}"`).get() as CountRow;
      db.close();
      return { columns, rows, total: countRow?.total ?? rows.length };
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'db_query_failed';
      return { error: detail };
    }
  });
};

app.whenReady().then(async () => {
  await fs.mkdir(getTempRoot(), { recursive: true });
  await fs.mkdir(getRuntimesRoot(), { recursive: true });
  await fs.mkdir(getPrivateAppsRoot(), { recursive: true });
  await ensureGlobalAgentsContext(getPrivateAppsRoot());
  await fs.mkdir(getCodexRoot(), { recursive: true });
  await fs.mkdir(getCodexHome(), { recursive: true });
  await loadPersistedSession();
  await loadRegistry();
  chatOrchestrator = new ChatOrchestrator({
    privateAppsRoot: getPrivateAppsRoot(),
    codexHome: getCodexHome(),
    agentContractVersion: FORGER_AGENT_CONTRACT_VERSION,
    getCodexCliPath: async () => await resolveCodexCliPath(getCodexRoot()),
    getCodexAuthenticated: async () => {
      const status = await getCodexAuthStatus();
      return status.authenticated;
    },
    onRunUpdated: (event) => {
      emitChatRunUpdated(event as { run: unknown });
    },
  });

  registerIpcHandlers();
  ensureCatalogStatuses();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('before-quit', () => {
  for (const running of runningApps.values()) {
    void terminateProcess(running.backend);
    void terminateProcess(running.frontend);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
