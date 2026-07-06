import type { ConnectionSetupGuide } from '../../../shared/types/connection-setup-guide';
import { secretFieldCopyValues, type SetupGuideContext } from './types';

export const githubSetupGuide = ({ definition, locale }: SetupGuideContext): ConnectionSetupGuide => {
  const es = locale === 'es';
  return {
    title: es ? 'Crear OAuth App de GitHub' : 'Create a GitHub OAuth App',
    summary: es
      ? 'GitHub usa device flow: Forger abre el navegador y tú autorizas con un código, sin callback local.'
      : 'GitHub uses device flow: Forger opens the browser and you authorize with a code, without a local callback.',
    portal: { label: 'GitHub Developer settings', url: 'https://github.com/settings/developers' },
    steps: es ? [
      'Abre Developer settings y crea una OAuth App.',
      'Completa el nombre y la homepage URL de tu preferencia.',
      'Habilita Device Flow en la configuración de la OAuth App.',
      'Copia el Client ID en Forger. Si GitHub muestra Client Secret para tu app, no lo pegues salvo que Forger lo pida.',
      'Presiona Conectar y completa la autorización en la ventana de GitHub.',
    ] : [
      'Open Developer settings and create an OAuth App.',
      'Fill in the app name and homepage URL you prefer.',
      'Enable Device Flow in the OAuth App settings.',
      'Copy the Client ID into Forger. If GitHub shows a Client Secret, do not paste it unless Forger asks for it.',
      'Press Connect and finish authorization in the GitHub browser window.',
    ],
    copyValues: secretFieldCopyValues(definition.secretsSchema, es ? 'Campo de Forger' : 'Forger field'),
    notes: es ? [
      'Device flow evita problemas de redirect URI en desktop y equipos headless.',
    ] : [
      'Device flow avoids redirect URI issues on desktop and headless machines.',
    ],
    commonErrors: es ? [
      'Si GitHub dice authorization_pending, espera y completa el código en el navegador.',
      'Si dice access_denied, vuelve a conectar y aprueba la OAuth App.',
    ] : [
      'If GitHub says authorization_pending, wait and enter the code in the browser.',
      'If it says access_denied, reconnect and approve the OAuth App.',
    ],
  };
};
