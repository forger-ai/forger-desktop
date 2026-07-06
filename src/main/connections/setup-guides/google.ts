import type { ConnectionSetupGuide } from '../../../shared/types/connection-setup-guide';
import { callbackCopyValues, scopeCopyValues, type SetupGuideContext } from './types';

export const googleSetupGuide = ({ definition, locale }: SetupGuideContext): ConnectionSetupGuide => {
  const es = locale === 'es';
  const callbackLabel = es ? 'URL de callback' : 'Callback URL';
  const scopeLabel = es ? 'Scope requerido' : 'Required scope';
  return {
    title: es
      ? `Crear cliente OAuth para ${definition.displayName}`
      : `Create an OAuth client for ${definition.displayName}`,
    summary: es
      ? 'Usa un cliente OAuth propio de Google Cloud. Forger guarda tus credenciales y tokens localmente.'
      : 'Use your own Google Cloud OAuth client. Forger stores credentials and tokens locally.',
    portal: { label: 'Google Cloud Console', url: 'https://console.cloud.google.com/apis/credentials' },
    steps: es ? [
      'Abre Google Cloud Console y selecciona o crea un proyecto.',
      'Configura OAuth consent screen en Google Auth Platform y agrega tu usuario como test user si la app está en testing.',
      'Habilita la API de Google que corresponde a esta conexión.',
      'Crea un OAuth client ID de tipo Desktop app.',
      'Copia Client ID y Client Secret en Forger y presiona Conectar.',
    ] : [
      'Open Google Cloud Console and select or create a project.',
      'Configure the OAuth consent screen in Google Auth Platform and add yourself as a test user if the app is in testing.',
      'Enable the Google API that matches this connection.',
      'Create an OAuth client ID with application type Desktop app.',
      'Copy Client ID and Client Secret into Forger, then connect.',
    ],
    copyValues: [
      ...callbackCopyValues(definition, callbackLabel),
      ...scopeCopyValues(definition, scopeLabel),
    ],
    notes: es ? [
      'El cliente Desktop app de Google no exige registrar esta callback URL exacta.',
      'Forger solicita acceso offline para poder refrescar tokens sin Forger Cloud.',
    ] : [
      'Google Desktop app clients do not require registering this exact callback URL.',
      'Forger requests offline access so it can refresh tokens without Forger Cloud.',
    ],
    commonErrors: es ? [
      'Si aparece access_denied, revisa test users y scopes del consent screen.',
      'Si la API responde 403, confirma que la API del servicio está habilitada en el proyecto.',
    ] : [
      'If you see access_denied, review test users and consent-screen scopes.',
      'If the API returns 403, confirm the service API is enabled in the project.',
    ],
  };
};
