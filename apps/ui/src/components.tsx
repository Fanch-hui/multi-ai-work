import type { ReactNode } from "react";
import { ArrowUpRight, Inbox } from "lucide-react";
import { cn } from "./classNames.js";
export { cn } from "./classNames.js";
export { Button, Field, ErrorNote, inputClass } from "./controls.js";
import { AgentActivity } from "./AgentActivity.js";
export { Modal, Confirm } from "./dialogs.js";
export function Empty({
  title,
  description,
  action,
  compact,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-3 py-8" : "min-h-64 gap-4 p-8",
      )}
    >
      <div className="flex size-10 items-center justify-center rounded-full bg-slate-50 text-slate-400">
        <Inbox size={19} />
      </div>
      <div>
        <h3 className="text-balance text-base font-semibold text-slate-800">{title}</h3>
        {description && <p className="mt-2 max-w-sm text-pretty text-sm leading-6 text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 px-7 py-5">
      <div>
        {eyebrow && <p className="mb-1 text-xs font-medium text-blue-700">{eyebrow}</p>}
        <h1 className="text-balance text-xl font-semibold text-slate-800">{title}</h1>
        {description && <p className="mt-1.5 text-pretty text-sm text-slate-500">{description}</p>}
      </div>
      {action}
    </div>
  );
}
const statusLabels: Record<string, string> = {
  ready: "可用",
  untested: "待检测",
  error: "连接异常",
  needs_auth: "待登录",
  recovering: "正在恢复连接",
  queued: "排队中",
  running: "思考中",
  waiting_children: "等待成员",
  waiting_approval: "待审批",
  waiting_input: "等待输入",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
  candidate: "待审核",
  approved: "已批准",
  revoked: "已撤销",
  superseded: "已替代",
  pending: "待确认",
  rejected: "已拒绝",
};
export function Badge({ status, children }: { status?: string; children?: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium",
        ["ready", "completed", "approved"].includes(status || "")
          ? "bg-blue-50 text-blue-800"
          : ["failed", "error"].includes(status || "")
            ? "bg-red-50 text-red-700"
            : ["running", "recovering", "waiting_approval", "candidate", "needs_auth", "pending"].includes(status || "")
              ? "bg-amber-50 text-amber-800"
              : "bg-slate-100 text-slate-500",
      )}
    >
      {status === "running" && !children ? <AgentActivity label="正在工作中" className="text-inherit" /> : children ?? statusLabels[status || ""] ?? status}
    </span>
  );
}
export function Avatar({ name, color, small }: { name: string; color?: string; small?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl bg-slate-100 font-semibold text-slate-600",
        small ? "size-7 rounded-lg text-xs" : "size-10 text-sm",
      )}
      style={color ? { color, backgroundColor: `${color}14` } : undefined}
    >
      {name.slice(0, 1)}
    </span>
  );
}
export function LinkAction({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      className="inline-flex items-center gap-1 text-sm font-medium text-blue-700 hover:underline"
      onClick={onClick}
    >
      {children}
      <ArrowUpRight size={14} />
    </button>
  );
}
export function timeLabel(value: string): string {
  return new Date(value).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
export const activeTask = (status: string) =>
  ["queued", "running", "recovering", "waiting_children", "waiting_approval", "waiting_input"].includes(status);
