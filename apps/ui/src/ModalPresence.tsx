import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const ModalVisibility = createContext(true);
export const useModalVisible = () => useContext(ModalVisibility);

export function ModalPresence({ show, children }: { show: boolean; children: ReactNode }) {
  const [retained, setRetained] = useState(show);
  const lastChildren = useRef(children);
  if (show) lastChildren.current = children;
  useEffect(() => {
    if (show) {
      setRetained(true);
      return;
    }
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 80 : 160;
    const timer = window.setTimeout(() => setRetained(false), delay);
    return () => window.clearTimeout(timer);
  }, [show]);
  if (!show && !retained) return null;
  return (
    <ModalVisibility.Provider value={show}>
      {show ? children : lastChildren.current}
    </ModalVisibility.Provider>
  );
}
