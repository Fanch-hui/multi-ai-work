import { ModalPresence } from "./ModalPresence.js";
import { useState } from "react";
import { Brain, Library, PanelLeftClose, Phone, Plus, Search, Settings2, Store, Users } from "lucide-react";
import type { Snapshot } from "../../../src/domain/types.js";
import { Button, cn } from "./components.js";
import type { Mutate } from "./store.js";
import { ConversationActions } from "./ConversationActions.js";
import { SidebarConversationList } from "./SidebarConversationList.js";
import { SidebarAppUpdate } from "./AppUpdate.js";
export type Page = "chat" | "agents" | "tasks" | "memory" | "market" | "settings";
const navigation = [
  { id: "agents", label: "我的团队", icon: Users },
  { id: "market", label: "智能体市场", icon: Store },
  { id: "tasks", label: "库", icon: Library },
  { id: "memory", label: "记忆", icon: Brain },
  { id: "settings", label: "连接与设置", icon: Settings2 },
] as const;
export function MainSidebar({ collapsed = false, data, page, selectedId, onPage, onSelect, onCreate, onCreateGroup, onCollapse, mutate }: {
  collapsed?: boolean; data?: Snapshot; page: Page; selectedId?: string; onPage: (page: Page) => void;
  onSelect: (id: string) => void; onCreate: () => void; onCreateGroup: () => void;
  onCollapse: () => void; mutate: Mutate;
}) {
  const [query, setQuery] = useState("");
  const [manageId, setManageId] = useState("");
  const managed = data?.conversations.find((item) => item.id === manageId);
  return <div className="sidebar-shell" data-collapsed={collapsed} inert={collapsed} aria-hidden={collapsed || undefined}><aside className="app-sidebar flex w-64 shrink-0 flex-col px-3 pb-3 max-md:w-52" aria-label="工作台侧边栏">
    <div className="app-titlebar flex h-12 shrink-0 items-center justify-end">
      <Button variant="ghost" className="size-8 min-h-8 p-0" aria-label="收起侧边栏" title="收起侧边栏" onClick={onCollapse}>
        <PanelLeftClose size={17} />
      </Button>
    </div>
    <div className="mb-4 flex shrink-0 items-center gap-1 px-3">
    <button className="flex min-w-0 flex-1 items-center gap-2.5 text-left text-base font-semibold text-slate-900"
      onClick={() => data?.settings.mainConversationId && onSelect(data.settings.mainConversationId)} aria-label="打开主智能体对话">
      <img src={`${import.meta.env.BASE_URL}app-icon.png`} alt="" className="size-7 shrink-0 rounded-lg" /><span className="truncate">multi-AI work</span>
    </button>
    <SidebarAppUpdate />
    </div>
    <div className="mb-3 flex shrink-0 gap-2">
      <Button className="h-10 min-w-0 flex-1 border-black/6 bg-white/70 font-medium" onClick={onCreateGroup} disabled={!data}>
        <Plus size={16} />新对话
      </Button>
      <Button className="size-10 shrink-0 border-black/6 bg-white/70 p-0" onClick={onCreate} disabled={!data}
        aria-label="呼叫管家，创建主对话" title="呼叫管家"><Phone size={16} /></Button>
    </div>
    <div className="relative mb-2 shrink-0 px-1"><Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
      <input aria-label="搜索会话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索对话"
        className="min-h-9 w-full rounded-lg border-0 bg-transparent py-2 pl-8 pr-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white/70 focus:ring-1 focus:ring-blue-500" />
    </div>
    <SidebarConversationList data={data} archived={false} query={query} selectedId={page === "chat" ? selectedId : undefined}
      onSelect={onSelect} onManage={setManageId} />
    <nav className="grid shrink-0 gap-0.5 border-t border-black/5 pt-2" aria-label="主导航">
      {navigation.map((item) => <button key={item.id} onClick={() => onPage(item.id)} aria-current={page === item.id ? "page" : undefined}
        className={cn("sidebar-row flex min-h-8 items-center gap-2 rounded-lg px-3 text-left text-sm leading-5",
          page === item.id ? "bg-black/6 text-slate-950" : "text-slate-600 hover:bg-black/4")}>
        <span className="inline-flex size-5 shrink-0 items-center justify-center"><item.icon size={14} /></span><span>{item.label}</span>
      </button>)}
    </nav>
    <ModalPresence show={!!managed}>{managed && <ConversationActions conversation={managed} mutate={mutate} close={() => setManageId("")} />}</ModalPresence>
  </aside></div>;
}
