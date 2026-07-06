import type { ConnectionSetupGuide } from '../../../shared/types/connection-setup-guide';
import type { SetupGuideContext } from './types';

export const qrSetupGuide = ({ definition, locale }: SetupGuideContext): ConnectionSetupGuide => {
  const es = locale === 'es';
  return {
    title: es
      ? `Vincular ${definition.displayName}`
      : `Pair ${definition.displayName}`,
    summary: es
      ? 'Esta conexión se vincula localmente con un código QR y no requiere token pegado manualmente.'
      : 'This connection pairs locally with a QR code and does not require manually pasted tokens.',
    steps: es ? [
      'Presiona Conectar para crear la sesión local.',
      'Abre WhatsApp en tu teléfono y entra a Dispositivos vinculados.',
      'Escanea el QR que Forger muestra y espera el estado conectado.',
    ] : [
      'Press Connect to create the local session.',
      'Open WhatsApp on your phone and go to Linked devices.',
      'Scan the QR shown by Forger and wait for the connected status.',
    ],
    notes: es ? [
      'La sesión queda en este equipo. Puedes desconectarla desde Forger o desde WhatsApp.',
    ] : [
      'The session stays on this computer. You can disconnect it from Forger or from WhatsApp.',
    ],
    commonErrors: es ? [
      'Si el QR vence, cierra y vuelve a abrir el modal de conexión.',
    ] : [
      'If the QR expires, close and reopen the connection modal.',
    ],
  };
};
