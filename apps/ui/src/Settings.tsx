import { PageSurface } from "./PageSurface.js";
import { useState, type ReactNode } from "react";
import type { Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { PageHeader, cn } from "./components.js";
import { Connections } from "./Connections.js";
import { Integrations } from "./Integrations.js";
import { Workspaces } from "./Workspaces.js";
import { General } from "./GeneralSettings.js";
import { PersonalSettings } from "./PersonalSettings.js";
import { ArchivedConversations } from "./ArchivedConversations.js";
const tabs = [
  { id: "personal", label: "个人信息" },
  { id: "connections", label: "模型供应" },
  { id: "tools", label: "工具与 Skills" },
  { id: "workspaces", label: "工作目录" },
  { id: "archived", label: "已归档会话" },
  { id: "general", label: "运行与备份" },
] as const;
export function Settings({ data, mutate, headerLeading, onSelectConversation }: {
  data: Snapshot; mutate: Mutate; headerLeading?: ReactNode; onSelectConversation?: (id: string) => void;
}) {
  const [tab, setTab] = useState<(typeof tabs)[number]["id"]>("connections");
  return (
    <PageSurface headerLeading={headerLeading} contentClassName="px-7 pb-7" header={<>
      <PageHeader title="连接与设置" />
      <div className="flex shrink-0 flex-wrap gap-x-5 px-7" aria-label="设置分类">
        {tabs.map((item) => (
          <button
            id={`tab-${item.id}`}
            aria-controls={`panel-${item.id}`}
            aria-pressed={tab === item.id}
            key={item.id}
            className={cn(
              "border-b-2 px-1 py-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600",
              tab === item.id
                ? "border-blue-700 text-blue-700"
                : "border-transparent text-slate-500 hover:text-slate-900",
            )}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      </>}>
      <div id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        <div className="w-full max-w-5xl">
          {tab === "connections" && <Connections data={data} mutate={mutate} />}
          {tab === "personal" && <PersonalSettings data={data} mutate={mutate} />}
          {tab === "tools" && <Integrations data={data} mutate={mutate} />}
          {tab === "workspaces" && <Workspaces data={data} mutate={mutate} />}
          {tab === "general" && <General data={data} mutate={mutate} />}
          {tab === "archived" && <ArchivedConversations data={data} mutate={mutate} onSelectConversation={onSelectConversation} />}
        </div>
      </div>
    </PageSurface>
  );
}
