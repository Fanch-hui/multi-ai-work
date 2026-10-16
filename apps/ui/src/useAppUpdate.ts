import { useEffect, useRef, useState } from 'react';
import type { AppUpdateState } from '../../../src/domain/app-update.js';
import { appUpdateBridge, errorMessage, type AppUpdateCommand } from './api.js';

export function useAppUpdate() {
  const [state, setState] = useState<AppUpdateState>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState<AppUpdateCommand>();
  const revision = useRef(0);
  const operation = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    const bridge = appUpdateBridge();
    if (!bridge) return () => { active = false; mounted.current = false; };
    const unsubscribe = bridge.subscribe(value => {
      revision.current++;
      setState(value);
      setError('');
    });
    const initialRevision = revision.current;
    void bridge.request('state').then(value => {
      if (active && revision.current === initialRevision) setState(value);
    }).catch(cause => {
      if (active && revision.current === initialRevision) setError(errorMessage(cause));
    });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, []);
  async function run(command: AppUpdateCommand) {
    const bridge = appUpdateBridge();
    if (!bridge) return;
    const currentOperation = ++operation.current;
    const currentRevision = revision.current;
    setPending(command);
    setError('');
    try {
      const value = await bridge.request(command);
      if (mounted.current && operation.current === currentOperation && revision.current === currentRevision) setState(value);
      return value;
    } catch (cause) {
      if (mounted.current && operation.current === currentOperation) setError(errorMessage(cause));
    } finally {
      if (mounted.current && operation.current === currentOperation) setPending(undefined);
    }
  }
  return { state, error, pending, run };
}

export type AppUpdate = ReturnType<typeof useAppUpdate>;
