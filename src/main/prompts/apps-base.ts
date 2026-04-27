import { FORGER_AGENT_CONTRACT_MARKER } from './forger-base';

export interface PromptAppManifestService {
  name?: string;
  type?: string;
  port?: number;
  command?: string;
  healthcheck?: string;
  context?: string;
}

export interface PromptAppManifestStackSection {
  language?: string;
  framework?: string;
  package_manager?: string;
  database?: string;
  bundler?: string;
  ui?: string;
}

export interface PromptAppManifestStack {
  backend?: PromptAppManifestStackSection;
  frontend?: PromptAppManifestStackSection;
}

export interface PromptAppManifest {
  name?: string;
  version?: string;
  description?: string;
  stack?: PromptAppManifestStack;
  services?: PromptAppManifestService[];
  scripts?: Record<string, string>;
  skills?: string[];
}

const hasValidManifestStack = (manifest: PromptAppManifest | null): manifest is PromptAppManifest & { stack: PromptAppManifestStack } => {
  if (!manifest?.stack || typeof manifest.stack !== 'object') {
    return false;
  }
  const backend = manifest.stack.backend && typeof manifest.stack.backend === 'object';
  const frontend = manifest.stack.frontend && typeof manifest.stack.frontend === 'object';
  return Boolean(backend || frontend);
};

const summarizeStack = (stack: PromptAppManifestStack): string[] => {
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

export const buildForgerAppAgentsMarkdown = (appId: string, manifest: PromptAppManifest | null): string => {
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
    '## Archivos Compartidos Desde Forger',
    '- La app puede recibir archivos compartidos desde el home global de Forger cuando el usuario los adjunta o menciona explicitamente.',
    '- Esos archivos viven bajo `data/` o `dev-data/` desde el home de Forger, segun el entorno, y se entregan en el prompt del mensaje.',
    '- Usa solo los archivos listados en el mensaje actual. No busques archivos adicionales por tu cuenta.',
    '- Los archivos compartidos son entrada de usuario para cumplir una tarea; no son parte permanente de las capacidades de la app salvo que la app los importe o procese explicitamente.',
    '',
    '## Capacidades visibles para el usuario',
    '- Si una app trae su propio `AGENTS.md`, las capacidades visibles deben estar documentadas ahi.',
    '- Si esta app solo tiene este archivo generado por Forger, no declares capacidades especificas sin revisar la UI, rutas, textos, modelos y servicios reales.',
    '- Una capacidad visible es algo que el usuario puede pedir o entender como una accion real de la app, por ejemplo revisar informacion, importar datos, corregir registros o ver un resumen.',
    '- No presentes scripts, rutas, comandos, endpoints, archivos temporales ni carpetas internas como capacidades visibles.',
    '- Si no encuentras evidencia suficiente para una capacidad, responde que no aparece como capacidad actual de la app.',
    '',
    '## Herramientas internas del agente',
    '- Las herramientas internas son recursos que puedes usar para cumplir una tarea: scripts, comandos, endpoints, skills, archivos compartidos, archivos temporales, consultas a base de datos o validaciones.',
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
