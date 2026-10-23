import type { ToolExecutionContext } from '../domain/tools.js';
import type { Routine } from '../domain/routines.js';
import type { State } from './state.js';
import type { RoutineService } from './routines.js';
import type { ArtifactReviewService } from './artifact-reviews.js';
import type { BrowserService } from './work-browser.js';

export function workToolContext(
  state: State,
  routines: RoutineService,
  reviews: ArtifactReviewService,
  browser: BrowserService,
  desktop: boolean,
): Pick<ToolExecutionContext, 'executeBrowser' | 'manageRoutines' | 'recordArtifactReview'> {
  return {
    ...(desktop
      ? {
          executeBrowser: (
            name: string,
            args: Record<string, unknown>,
            context: ToolExecutionContext,
          ) => browser.execute(name, args, context),
        }
      : {}),
    recordArtifactReview: (args, context) => reviews.record(context, args),
    manageRoutines: async (args, context) => {
      if (context.botId !== state.settings().mainBotId) throw new Error('只有主管可管理例行工作');
      const { action, ...params } = args;
      if (typeof action !== 'string') throw new Error('例行工作操作无效');
      if (['save', 'setEnabled', 'runNow'].includes(action)) {
        if (!(await context.requestApproval('manage_routines', '设置例行工作', args)))
          throw new Error('例行工作操作未获批准');
        context.assertAuthorized?.();
        const input = params.input as Record<string, unknown> | undefined;
        const existing =
          typeof params.id === 'string'
            ? state.storage.get<Routine>('routines', params.id)
            : undefined;
        const ids = input?.inputArtifactIds ?? existing?.inputArtifactIds ?? [];
        if (!Array.isArray(ids)) throw new Error('例行工作资料无效');
        // Creation transfers only material the current task can actually read.
        if (
          action === 'save' &&
          ids.some((id) => typeof id !== 'string' || !context.findArtifact(id))
        )
          throw new Error('例行工作资料未授权');
        context.markDispatched?.();
      }
      if (action === 'runNow') params.requestId = `${context.runId}:${context.callId}`;
      return routines.request(`routines.${action}`, params);
    },
  };
}
