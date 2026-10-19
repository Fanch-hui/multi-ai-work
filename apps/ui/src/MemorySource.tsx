import { useEffect, useState } from 'react';
import type { MemoryEntry, Message } from '../../../src/domain/types.js';
import { errorMessage, request } from './api.js';

export function MemorySource({
  id,
  loaded,
  version,
}: {
  id: string;
  loaded?: Message;
  version: MemoryEntry;
}) {
  const [message, setMessage] = useState<Message | undefined>(loaded);
  const [status, setStatus] = useState(loaded ? '' : '正在读取来源…');
  useEffect(() => {
    let current = true;
    if (loaded) {
      setMessage(loaded);
      setStatus('');
      return;
    }
    setMessage(undefined);
    setStatus('正在读取来源…');
    void request<Message[]>('messages.get', { ids: [id] })
      .then((messages) => {
        if (!current) return;
        setMessage(messages[0]);
        setStatus(messages.length ? '' : '来源消息已删除');
      })
      .catch((error) => {
        if (current) setStatus(`来源读取失败：${errorMessage(error)}`);
      });
    return () => {
      current = false;
    };
  }, [id, loaded, version]);
  return (
    <blockquote className="mt-3 rounded-lg bg-slate-50 p-3 text-pretty leading-5">
      {message?.content || status || '来源消息为空'}
    </blockquote>
  );
}
