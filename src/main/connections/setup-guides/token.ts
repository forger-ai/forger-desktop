import type { ConnectionSetupGuide } from '../../../shared/types/connection-setup-guide';
import { secretFieldCopyValues, type SetupGuideContext } from './types';
import { tokenProviderPermissionHint, tokenProviderPortals } from './token-portals';

export const tokenSetupGuide = ({ definition, locale }: SetupGuideContext): ConnectionSetupGuide => {
  const es = locale === 'es';
  const portalUrl = tokenProviderPortals[definition.type];
  return {
    title: es
      ? `Crear credencial para ${definition.displayName}`
      : `Create credentials for ${definition.displayName}`,
    summary: es
      ? 'Esta conexión usa token o API key local. Forger no usa OAuth de Forger Cloud para este proveedor.'
      : 'This connection uses a local token or API key. Forger does not use Forger Cloud OAuth for this provider.',
    ...(portalUrl ? { portal: { label: definition.displayName, url: portalUrl } } : {}),
    steps: es ? [
      'Abre el portal del proveedor y crea una app, bot, integración o API key según el servicio.',
      'Asigna solo los permisos mínimos que coinciden con las acciones que usarás en Forger.',
      'Copia los campos requeridos que Forger muestra en el formulario de conexión.',
      'Guarda la credencial en Forger y prueba el estado de la conexión.',
    ] : [
      'Open the provider portal and create an app, bot, integration, or API key for the service.',
      'Grant only the minimum permissions that match the actions you will use in Forger.',
      'Copy the required fields shown in the Forger connection form.',
      'Save the credential in Forger and test the connection status.',
    ],
    copyValues: secretFieldCopyValues(definition.secretsSchema, es ? 'Campo requerido' : 'Required field'),
    notes: [
      tokenProviderPermissionHint(definition.type, es),
      es
        ? 'Nunca pegues tokens en chats o documentos; ingrésalos solo en el formulario de conexión.'
        : 'Never paste tokens into chats or documents; enter them only in the connection form.',
    ],
    commonErrors: es ? [
      '401 o unauthorized suele indicar token incorrecto, vencido o sin permisos suficientes.',
      '404 en servicios de workspace suele indicar URL, dominio, tienda, servidor o recurso no compartido.',
    ] : [
      '401 or unauthorized usually means the token is wrong, expired, or missing permissions.',
      '404 in workspace services usually means a URL, domain, shop, server, or shared resource is wrong.',
    ],
  };
};
