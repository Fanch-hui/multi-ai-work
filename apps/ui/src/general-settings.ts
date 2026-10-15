import type { Settings, Snapshot } from "../../../src/domain/types.js";
import type { Request } from "./api.js";

export function generalSettings(settings: Settings) {
  const { maxActiveRuns, maxChildren, maxCoordinationRounds, autoAnswerMemberQuestions, trayEnabled } = settings;
  return { maxActiveRuns, maxChildren, maxCoordinationRounds, autoAnswerMemberQuestions, trayEnabled };
}

export async function restoreGeneralSettings(path: string, mutate: Request, snapshot: () => Promise<Snapshot>) {
  await mutate("backup.restore", { path });
  return generalSettings((await snapshot()).settings);
}
