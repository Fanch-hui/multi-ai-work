import { useId, useRef, useState, type FormEvent } from "react";
import { Check, X } from "lucide-react";
import type { Snapshot, UserQuestion } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import Avatar from "./Avatar.js";
import { Button, ErrorNote, inputClass, timeLabel } from "./components.js";
import { cn } from './classNames.js';
import { ResolvedQuestionCard } from './ResolvedQuestionCard.js';

export function UserQuestionCard({ question, data, mutate, hideResolved = false }: {
  question: UserQuestion; data: Snapshot; mutate: Mutate; hideResolved?: boolean;
}) {
  const fieldId = useId();
  const submitting = useRef(false);
  const [selected, setSelected] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState<'answered' | 'cancelled'>();
  const bot = data.bots.find((item) => item.id === question.botId);
  const answerBot = data.bots.find((item) => item.id === (question.answerBotId || data.settings.mainBotId));
  const chiefTask = data.tasks.find((item) => item.id === question.chiefTaskId);
  const status = question.status === 'pending' && resolved ? resolved : question.status;
  const pending = status === "pending";
  const automatic = pending && !!question.autoAnswerAt && !question.autoAnswerError && data.settings.autoAnswerMemberQuestions;
  const chiefAnswerStatus = automatic && (chiefTask?.status === "queued" ? "等待主管代答；你仍可提交回答。"
    : chiefTask?.status === "running" ? "主管正在代答；你仍可提交回答。"
    : "2 分钟内未回答，将由主管决定回复。");
  const answer = text.trim() || selected;
  async function resolve(cancel = false) {
    if (submitting.current || !pending || (!cancel && !answer)) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      await mutate(cancel ? "questions.cancel" : "questions.answer", {
        id: question.id,
        ...(!cancel && { answer }),
      });
      setResolved(cancel ? 'cancelled' : 'answered');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void resolve();
  }
  if (!pending && hideResolved) return null;
  if (!pending) return <ResolvedQuestionCard question={question} bot={bot} answerBot={answerBot} status={status}
    answer={question.answer ?? (resolved === 'answered' ? answer : undefined)} />;
  return (
    <article className="min-w-0 rounded-lg border border-blue-200 bg-blue-50 p-3" aria-busy={busy}>
      <div className="mb-2 flex items-center gap-2">
        <Avatar bot={bot} name={bot?.name || "智能体"} className="size-5 rounded-md" />
        <span className="text-xs font-medium text-blue-800">{bot?.name || "智能体"} 提问</span>
        <span className="ml-auto text-xs text-slate-500">{timeLabel(question.createdAt)}</span>
      </div>
      <h3 id={`${fieldId}-question`} className="whitespace-pre-wrap break-words text-pretty text-sm font-medium leading-5 text-slate-900">
        {question.question}
      </h3>
      <form className="mt-2 grid min-w-0 grid-cols-1 gap-2" onSubmit={submit}>
        {chiefAnswerStatus && <p role="status" className="text-xs leading-5 text-blue-800">{chiefAnswerStatus}</p>}
        {question.autoAnswerError && <p role="alert" className="text-xs leading-5 text-red-700">
          主管未能代答：{question.autoAnswerError}。请提交你的回答。
        </p>}
        {!!question.options?.length && <fieldset disabled={busy} aria-labelledby={`${fieldId}-question`} className="grid min-w-0 grid-cols-1 gap-1.5">
          {question.options.map((option, index) => <label key={index} className="flex cursor-pointer items-start gap-2 rounded-md border border-black/8 bg-white px-2 py-1.5 text-xs text-slate-700">
            <input type="radio" name={fieldId} value={option.label} checked={selected === option.label}
              className="mt-0.5 accent-blue-600"
              onChange={() => { setSelected(option.label); setText(""); }} />
            <span className="min-w-0 break-words">{option.label}{option.description && <span className="mt-0.5 block leading-4 text-slate-500">{option.description}</span>}</span>
          </label>)}
        </fieldset>}
        <label className="grid min-w-0 grid-cols-1 gap-1 text-xs font-medium text-slate-600" htmlFor={fieldId}>
          {question.options?.length ? "或填写回答" : "你的回答"}
          <textarea id={fieldId} rows={2} className={cn(inputClass, 'min-h-9 px-2 py-1.5')} value={text} disabled={busy}
            onChange={(event) => { setText(event.target.value); setSelected(""); }} />
        </label>
        <ErrorNote error={error} />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" className="min-h-8 px-2.5 py-1.5 text-xs" disabled={busy || !answer}>
            <Check size={14} aria-hidden="true" />{busy ? "提交中…" : "提交回答"}
          </Button>
          <Button type="button" className="min-h-8 px-2.5 py-1.5 text-xs" disabled={busy} onClick={() => void resolve(true)}>
            <X size={14} aria-hidden="true" />取消任务
          </Button>
        </div>
      </form>
    </article>
  );
}
