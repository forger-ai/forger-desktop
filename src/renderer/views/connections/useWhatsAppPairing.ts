import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallConnectionActionResult } from '@shared/types';
import { getWhatsAppPairingPresentation, type WhatsAppPairingPresentation } from '@shared/connections-pairing';

type Options = {
  failureMessage: string;
  onConnected: (connectionId: string, isCurrent: () => boolean) => Promise<void> | void;
};

/** Each modal attempt owns its timers and replies; closing never resets WhatsApp data. */
export function useWhatsAppPairing(options: Options) {
  const callbacks = useRef(options);
  useEffect(() => { callbacks.current = options; }, [options]);
  const generation = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<WhatsAppPairingPresentation>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const cancel = useCallback(() => {
    generation.current++;
    clearTimeout(pollTimer.current);
    clearTimeout(expiryTimer.current);
  }, []);
  useEffect(() => cancel, [cancel]);
  const stop = useCallback(() => {
    cancel();
    setConnectionId(null);
    setPresentation({ kind: 'idle' });
    setBusy(false);
  }, [cancel]);
  const start = useCallback(async (id: string) => {
    cancel();
    const attempt = generation.current;
    const current = () => attempt === generation.current;
    setConnectionId(id);
    setBusy(true);
    setPresentation({ kind: 'waiting' });
    const fail = () => {
      clearTimeout(expiryTimer.current);
      setPresentation({ kind: 'error', message: callbacks.current.failureMessage });
    };
    const accept = async (result: CallConnectionActionResult): Promise<boolean> => {
      if (!current()) return false;
      clearTimeout(expiryTimer.current);
      const next = getWhatsAppPairingPresentation(result);
      if (next.kind === 'waiting' && ['connected', 'already_connected'].includes(next.status ?? '')) {
        setPresentation(next);
        await callbacks.current.onConnected(id, current);
        return false;
      }
      setPresentation(next);
      if (next.kind === 'qr' || next.kind === 'pairing_code') {
        const deadline = next.expiresAt ? Date.parse(next.expiresAt) : NaN;
        if (!Number.isFinite(deadline) || deadline <= Date.now()) {
          setPresentation({ kind: 'expired' });
        } else {
          expiryTimer.current = setTimeout(() => {
            if (current()) setPresentation({ kind: 'expired' });
          }, Math.min(deadline - Date.now(), 60_000));
        }
      }
      return next.kind !== 'error' && next.kind !== 'expired';
    };
    const schedule = () => {
      if (current()) pollTimer.current = setTimeout(() => { void poll(); }, 3000);
    };
    const poll = async () => {
      try {
        const result = await window.forger.connectionsPairingStatus(id);
        if (await accept(result)) schedule();
      } catch { if (current()) fail(); }
    };
    try {
      const result = await window.forger.connectionsCall({
        type: 'whatsapp', actionId: 'whatsapp.start_pairing', connectionId: id, input: { method: 'qr' },
      });
      if (await accept(result)) schedule();
    } catch { if (current()) fail(); }
    finally { if (current()) setBusy(false); }
  }, [cancel]);
  const retry = useCallback(async () => { if (connectionId) await start(connectionId); }, [connectionId, start]);
  return { connectionId, presentation, busy, start, stop, retry };
}
