import { useEffect, useRef, useState } from "react";
import type { Connection, ProviderKind } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage, snapshot } from "./api.js";

export interface LoginGuide { url?: string; instructions?: string; command?: string }
type Phase = "details" | "saving" | "checking" | "signingIn" | "authorization" | "waiting";

export function useConnectionFlow(connections: Connection[], mutate: Mutate, close: (connection: Connection) => void) {
  const [connectionId, setConnectionId] = useState<string>();
  const [phase, setPhase] = useState<Phase>("details");
  const [error, setError] = useState("");
  const [guide, setGuide] = useState<LoginGuide>();
  const authorizedRevision = useRef<number | undefined>(undefined);
  const current = connections.find((item) => item.id === connectionId);
  const busy = ["saving", "checking", "signingIn"].includes(phase);

  async function authorize(id: string) {
    setPhase("signingIn");
    setError("");
    try {
      const result = await mutate<LoginGuide>("connections.login", { id });
      setGuide(result);
      setPhase(result.url ? "waiting" : "authorization");
      if (result.url && !(window as Window & { aiTeam?: unknown }).aiTeam)
        window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (cause) { setPhase("authorization"); setError(errorMessage(cause)); }
  }

  async function check(id: string, provider: ProviderKind, offerLogin: boolean) {
    setPhase("checking");
    setError("");
    try {
      const connection = await mutate<Connection>("connections.probe", { id });
      close(connection);
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("authorization");
      if (offerLogin && provider !== "custom") {
        const failed = (await snapshot()).connections.find((item) => item.id === id);
        const needsLogin = failed?.status === "needs_auth" || provider !== "chatgpt" && !failed?.executable;
        if (needsLogin) await authorize(id);
      }
    }
  }

  async function connect(input: Record<string, unknown>, provider: ProviderKind) {
    setPhase("saving");
    setError("");
    setGuide(undefined);
    try {
      const saved = await mutate<Connection>("connections.save", {
        input: { ...input, id: connectionId ?? input.id },
      });
      setConnectionId(saved.id);
      await check(saved.id, provider, true);
    } catch (cause) {
      setPhase("details");
      setError(errorMessage(cause));
    }
  }

  useEffect(() => {
    if (phase !== "waiting" || current?.status !== "untested" || authorizedRevision.current === current.revision) return;
    authorizedRevision.current = current.revision;
    void check(current.id, current.provider, false);
  }, [phase, current?.status, current?.revision]);

  return {
    connectionId, phase, busy, error: error || (phase === "waiting" ? current?.error : undefined), guide,
    connect, setError,
    retry: () => current && check(current.id, current.provider, false),
    authorize: () => connectionId && authorize(connectionId),
    edit: () => { setPhase("details"); setGuide(undefined); setError(""); },
  };
}
