import { useEffect, useRef, useState } from 'react';
import type { Run, RunEvent, RunEventPage } from '../../../src/domain/types.js';
import { request, errorMessage } from './api.js';
import { mergeRecordEvents } from './work-record-events.js';

export function useRunRecords(run: Run, open: boolean, latestId?: string, view?: 'work') {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [cursor, setCursor] = useState<number>();
  const [loaded, setLoaded] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [paging, setPaging] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const initialized = useRef(false);
  const cachedIds = useRef(new Set<string>());
  const cursorRevision = useRef(0);
  const mounted = useRef(true);
  const earlierPending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) {
      setFetching(false);
      return;
    }
    let active = true;
    setFetching(true);
    setError('');
    void request<RunEventPage>('runs.events', { id: run.id, ...(view ? { view } : {}) })
      .then((page) => {
        if (!active) return;
        setEvents((previous) => mergeRecordEvents(previous, page.events));
        const overlaps = page.events.some((event) => cachedIds.current.has(event.id));
        // A new page can jump past the cached range after a long pause. Restart paging
        // from that page so the intervening operations remain reachable.
        if (!initialized.current || (page.events.length > 0 && !overlaps)) {
          cursorRevision.current++;
          setCursor(page.nextCursor);
        }
        for (const event of page.events) cachedIds.current.add(event.id);
        initialized.current = true;
        setLoaded(true);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      })
      .finally(() => {
        if (active) setFetching(false);
      });
    return () => {
      active = false;
    };
  }, [open, run.id, latestId, run.status, revision, view]);
  async function earlier() {
    if (cursor === undefined || earlierPending.current) return;
    earlierPending.current = true;
    setPaging(true);
    setError('');
    const revision = cursorRevision.current;
    try {
      const page = await request<RunEventPage>('runs.events', {
        id: run.id,
        cursor,
        ...(view ? { view } : {}),
      });
      if (!mounted.current) return;
      setEvents((previous) => mergeRecordEvents(previous, page.events));
      for (const event of page.events) cachedIds.current.add(event.id);
      if (revision === cursorRevision.current) setCursor(page.nextCursor);
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      earlierPending.current = false;
      if (mounted.current) setPaging(false);
    }
  }
  return {
    events,
    cursor,
    loaded,
    busy: fetching || paging,
    error,
    earlier,
    refresh: () => setRevision((value) => value + 1),
  };
}
