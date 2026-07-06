import type { ConnectionSetupGuide } from '../../../shared/types/connection-setup-guide';
import { callbackCopyValues, scopeCopyValues, secretFieldCopyValues, type SetupGuideContext } from './types';

export const metaAdsSetupGuide = ({ definition, locale }: SetupGuideContext): ConnectionSetupGuide => {
  const es = locale === 'es';
  return {
    title: es ? 'Configurar Meta Ads OAuth' : 'Configure Meta Ads OAuth',
    summary: es
      ? 'Usa una app propia de Meta. La callback URL visible debe estar registrada exactamente en Meta antes de conectar.'
      : 'Use your own Meta app. The visible callback URL must be registered exactly in Meta before connecting.',
    portal: { label: 'Meta for Developers', url: 'https://developers.facebook.com/apps/' },
    steps: es ? [
      'Crea o abre una app en Meta for Developers con acceso al negocio correcto.',
      'Agrega Facebook Login for Business y Marketing API si Meta lo solicita.',
      'Registra la Callback URL de Forger como Valid OAuth Redirect URI.',
      'Solicita o habilita los permisos de anuncios, páginas y leads que Forger muestra.',
      'Copia App ID y App Secret en Forger. Autoriza con un usuario o system user con acceso al ad account.',
    ] : [
      'Create or open a Meta for Developers app with access to the right business.',
      'Add Facebook Login for Business and Marketing API if Meta asks for them.',
      'Register the Forger Callback URL as a Valid OAuth Redirect URI.',
      'Request or enable the ads, pages, and leads permissions shown by Forger.',
      'Copy App ID and App Secret into Forger. Authorize with a user or system user that can access the ad account.',
    ],
    copyValues: [
      ...callbackCopyValues(definition, es ? 'URL de callback' : 'Callback URL'),
      ...scopeCopyValues(definition, es ? 'Permiso requerido' : 'Required permission'),
      ...secretFieldCopyValues(definition.secretsSchema, es ? 'Campo de Forger' : 'Forger field'),
    ],
    notes: es ? [
      'La app puede estar en modo dev con usuarios de prueba; producción requiere revisión o negocio verificado según Meta.',
      'Las campañas se crean pausadas y las acciones de leads son de alto riesgo porque contienen PII.',
    ] : [
      'The app can stay in dev mode with test users; production requires review or a verified business depending on Meta.',
      'Campaigns are created paused, and lead actions are high risk because they contain PII.',
    ],
    commonErrors: es ? [
      'Si aparece redirect_uri_mismatch, copia de nuevo la callback URL actual desde Forger.',
      'Si no aparecen leads, revisa leads_retrieval y que la página/formulario esté compartido con el usuario autorizado.',
    ] : [
      'If you see redirect_uri_mismatch, copy the current callback URL from Forger again.',
      'If leads do not appear, check leads_retrieval and that the page/form is shared with the authorized user.',
    ],
  };
};
