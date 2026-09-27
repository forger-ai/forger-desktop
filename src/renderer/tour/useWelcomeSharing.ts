import { useEffect, useRef, useState } from 'react';
import type { CampaignMeasurementStatus } from '@shared/campaign-measurement';
import { initializeCampaignMeasurement, MEASUREMENT_CHANGED_EVENT } from '@renderer/campaign-measurement';

/** The welcome checkbox is a draft. Only leaving welcome commits the choice. */
export function useWelcomeSharing({ active }: { active: boolean }) {
  const [status, setStatus] = useState<CampaignMeasurementStatus | null>(null);
  const [checked, setChecked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const completing = useRef(false);
  const pendingAdvance = useRef<(() => void) | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!active) return;
    let live = true;
    completing.current = false;
    pendingAdvance.current = null;
    setLoading(true);
    setBusy(false);
    setSaveFailed(false);
    setStatus(null);
    setChecked(false);
    let latestRequest = 0;
    const update = (value: CampaignMeasurementStatus) => {
      if (!live || completing.current) return;
      setStatus(value);
      setChecked(value.available && value.consent !== 'disabled');
      setLoading(false);
    };
    const initialRequest = latestRequest;
    void initializeCampaignMeasurement().then((value) => {
      if (initialRequest === latestRequest) update(value);
    }).catch(() => {
      // Missing measurement support never prevents using Forger and never opts in.
      if (live && initialRequest === latestRequest) setLoading(false);
    });
    const refresh = () => {
      const request = ++latestRequest;
      void window.forger.getCampaignMeasurementStatus().then((value) => {
        if (request === latestRequest) update(value);
      }).catch(() => {
        if (live && request === latestRequest) setLoading(false);
      });
    };
    window.addEventListener(MEASUREMENT_CHANGED_EVENT, refresh);
    return () => { live = false; window.removeEventListener(MEASUREMENT_CHANGED_EVENT, refresh); };
  }, [active]);

  const complete = async (advance: () => void) => {
    if (!active || loading || completing.current) return;
    completing.current = true;
    pendingAdvance.current = advance;
    setBusy(true);
    setSaveFailed(false);
    if (status?.available && (saveFailed || status.consent !== (checked ? 'enabled' : 'disabled'))) {
      try {
        const saved = await window.forger.setCampaignMeasurementConsent({ enabled: checked });
        if (!mounted.current) return;
        setStatus(saved);
        window.dispatchEvent(new Event(MEASUREMENT_CHANGED_EVENT));
      } catch {
        if (!mounted.current) return;
        completing.current = false;
        setBusy(false);
        setSaveFailed(true);
        return;
      }
    }
    if (mounted.current) advance();
  };

  const continueWithoutSaving = () => {
    if (!active || !saveFailed || completing.current || !pendingAdvance.current) return;
    completing.current = true;
    setBusy(true);
    setSaveFailed(false);
    pendingAdvance.current();
  };

  return {
    checked,
    setChecked,
    checkboxDisabled: loading || busy || !status?.available,
    actionsDisabled: loading || busy,
    unavailable: !loading && status?.available === false,
    loadFailed: !loading && status === null,
    saveFailed,
    complete,
    continueWithoutSaving,
  };
}
export type WelcomeSharingState = ReturnType<typeof useWelcomeSharing>;
