import { FORGER_AGENT_CONTRACT_VERSION } from './forger-base';

export interface PromptSharedFile {
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  source: 'attached' | 'mentioned';
}

const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) {
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

export const buildCodexPromptWithAppContext = (params: {
  appId: string;
  displayName: string;
  userPrompt: string;
  sharedFiles: PromptSharedFile[];
  sharedFilesRootName: string;
}): string => {
  const filesSection =
    params.sharedFiles.length === 0
      ? ['- No hay archivos compartidos en este mensaje.']
      : params.sharedFiles.map((file) =>
          [
            `- Nombre: ${file.name}`,
            `  Ruta relativa: ${params.sharedFilesRootName}/${file.relativePath}`,
            `  Peso: ${formatBytes(file.sizeBytes)}`,
            `  Fecha de modificacion: ${file.modifiedAt}`,
            `  Origen: ${file.source === 'attached' ? 'adjuntado recien' : 'mencionado con @'}`,
          ].join('\n'),
        );

  return [
    `APP SELECCIONADA: /${params.appId}`,
    `NOMBRE APP SELECCIONADA: ${params.displayName}`,
    `CONTRATO FORGER: ${FORGER_AGENT_CONTRACT_VERSION}`,
    '',
    'Instruccion operativa: sigue el contrato de Forger en AGENTS.md. Clasifica internamente la solicitud en una de las 4 tareas permitidas y revisa el contexto real de la app antes de responder.',
    '',
    'ARCHIVOS COMPARTIDOS EN ESTE MENSAJE:',
    ...filesSection,
    '',
    'MENSAJE USUARIO:',
    params.userPrompt.trim(),
  ].join('\n');
};
