import { useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export default function useTransformationPreview<T>(identity: string, onConflict: () => void) {
  const [preview, setPreview] = useState<T | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef(identity); current.current = identity;
  const sequence = useRef(0);
  useEffect(() => {
    sequence.current++;
    setPreview(null); setError(''); setBusy(false);
    return () => { sequence.current++; };
  }, [identity]);

  function cancel() {
    sequence.current++;
    setPreview(null); setBusy(false);
  }

  async function prepare(load: () => Promise<T>) {
    const key = current.current;
    const ticket = ++sequence.current;
    const active = () => key === current.current && ticket === sequence.current;
    setBusy(true); setError('');
    try {
      const next = await load();
      if (active()) setPreview(next);
    } catch (reason) {
      if (active()) {
        setError(reason instanceof Error ? reason.message : 'Не удалось подготовить преобразование');
        if (reason instanceof ApiError && reason.status === 409) onConflict();
      }
    } finally { if (active()) setBusy(false); }
  }
  return { preview, busy, error, prepare, cancel };
}
