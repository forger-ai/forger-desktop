export interface SetupGuideUiCopy {
  commonErrors: string;
  copy: string;
  close: string;
  notes: string;
  openProvider: string;
  steps: string;
  values: string;
  viewGuide: string;
}

export const getSetupGuideUiCopy = (locale?: string): SetupGuideUiCopy => {
  const es = locale?.toLowerCase().startsWith('es');
  return es ? {
    commonErrors: 'Errores comunes',
    copy: 'Copiar',
    close: 'Cerrar',
    notes: 'Notas de seguridad',
    openProvider: 'Abrir portal',
    steps: 'Pasos',
    values: 'Valores para copiar',
    viewGuide: 'Ver instrucciones',
  } : {
    commonErrors: 'Common errors',
    copy: 'Copy',
    close: 'Close',
    notes: 'Security notes',
    openProvider: 'Open provider',
    steps: 'Steps',
    values: 'Values to copy',
    viewGuide: 'Setup guide',
  };
};
