import { ChevronDown } from 'lucide-react';
import type { Bot, UserQuestion } from '../../../src/domain/types.js';
import Avatar from './Avatar.js';
import { timeLabel } from './components.js';

export function ResolvedQuestionCard({
  question,
  bot,
  answerBot,
  status,
  answer,
}: {
  question: UserQuestion;
  bot?: Bot;
  answerBot?: Bot;
  status: 'answered' | 'cancelled';
  answer?: string;
}) {
  const chiefAnswer = status === 'answered' && question.answerSource === 'chief';
  return (
    <details className="group min-w-0 w-full rounded-lg border border-slate-200 bg-slate-50/60">
      <summary className="flex min-h-10 min-w-0 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
        <Avatar bot={bot} name={bot?.name || '智能体'} className="size-5 rounded-md" />
        <span
          className="max-w-32 shrink-0 truncate font-medium text-slate-600"
          title={bot?.name || '智能体'}
        >
          {bot?.name || '智能体'}
        </span>
        <span className="shrink-0 text-slate-400">
          {status === 'cancelled' ? '已取消' : chiefAnswer ? '主管代答' : '已回答'}
        </span>
        <span className="min-w-0 flex-1 truncate text-slate-500" title={question.question}>
          {question.question}
        </span>
        <span className="shrink-0 text-slate-400 tabular-nums max-sm:hidden">
          {timeLabel(question.createdAt)}
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="shrink-0 text-slate-400 group-open:rotate-180"
        />
      </summary>
      <div className="grid min-w-0 grid-cols-1 gap-2 border-t border-slate-200 px-3 py-2.5">
        <p className="whitespace-pre-wrap break-words text-sm font-medium leading-5 text-slate-700">
          {question.question}
        </p>
        {chiefAnswer && (
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <Avatar
              bot={answerBot}
              name={answerBot?.name || '主管'}
              className="size-5 rounded-md"
            />
            <span>{answerBot?.name || '主管'} · 主管代答</span>
          </div>
        )}
        {status === 'answered' && (
          <p className="whitespace-pre-wrap break-words text-sm leading-5 text-slate-600">
            {!chiefAnswer && <span className="font-medium">回答：</span>}
            {answer}
          </p>
        )}
        {chiefAnswer && question.answerReason && (
          <p className="whitespace-pre-wrap text-xs leading-5 text-slate-500">
            <span className="font-medium">依据：</span>
            {question.answerReason}
          </p>
        )}
      </div>
    </details>
  );
}
