import { useEffect, useRef, useState } from 'react';
import type { Connection } from '../../../src/domain/types.js';
import { errorMessage } from './api.js';
import type { Mutate } from './store.js';

type Phase = 'idle' | 'starting' | 'waiting' | 'checking' | 'error';

export function useOnboardingLogin(
  connections: Connection[],
  mutate: Mutate,
  connected: (connection: Connection) => void,
) {
  const [id, setId] = useState<string>();
  const [phase, setPhase] = useState<Phase>('idle');
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState('');
  const attempt = useRef(0);
  const checkedRevision = useRef<number | undefined>(undefined);
  const authorizationRevision = useRef(0);
  const current = connections.find((item) => item.id === id);
  const busy = phase === 'starting' || phase === 'checking';

  async function check(connectionId: string) {
    const generation = attempt.current;
    setPhase('checking');
    setError('');
    try {
      const connection = await mutate<Connection>('connections.probe', { id: connectionId });
      if (generation !== attempt.current) return;
      setPhase('idle');
      connected(connection);
    } catch (cause) {
      if (generation !== attempt.current) return;
      setPhase(url ? 'waiting' : 'error');
      setError(errorMessage(cause));
    }
  }

  async function start() {
    const generation = ++attempt.current;
    setPhase('starting');
    setError('');
    setUrl(undefined);
    checkedRevision.current = undefined;
    try {
      const connection = id
        ? current
        : await mutate<Connection>('connections.save', {
            input: { name: 'ChatGPT', provider: 'chatgpt', authMode: 'oauth', concurrency: 5 },
          });
      if (!connection || generation !== attempt.current) return;
      authorizationRevision.current = connection.revision;
      setId(connection.id);
      const guide = await mutate<{ url?: string }>('connections.login', { id: connection.id });
      if (generation !== attempt.current) return;
      setUrl(guide.url);
      setPhase('waiting');
      if (guide.url && !(window as Window & { aiTeam?: unknown }).aiTeam)
        window.open(guide.url, '_blank', 'noopener,noreferrer');
    } catch (cause) {
      if (generation !== attempt.current) return;
      setPhase('error');
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    if (
      phase !== 'waiting' ||
      current?.status !== 'untested' ||
      current.revision <= authorizationRevision.current ||
      checkedRevision.current === current.revision
    )
      return;
    checkedRevision.current = current.revision;
    void check(current.id);
  }, [phase, current?.status, current?.revision]);

  function reset() {
    attempt.current += 1;
    setPhase('idle');
    setError('');
    setUrl(undefined);
  }
  return {
    phase,
    busy,
    url,
    error: error || (phase === 'waiting' ? current?.error : undefined),
    start,
    reset,
    retry: () => id && check(id),
  };
}
