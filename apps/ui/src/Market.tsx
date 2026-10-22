import { useState, type ReactNode } from 'react';
import { ArrowLeft, Download, RefreshCw, Search, Upload } from 'lucide-react';
import type { Snapshot, Bot } from '../../../src/domain/types.js';
import type { MarketState, PresetInstallation } from '../../../src/domain/market.js';
import type { Mutate } from './store.js';
import { Button, Empty, ErrorNote, PageHeader, cn, inputClass } from './components.js';
import { PageSurface } from './PageSurface.js';
import { ModalPresence } from './ModalPresence.js';
import { BotEditor } from './BotEditor.js';
import { useMarket } from './market/useMarket.js';
import { usePresetHiring } from './market/usePresetHiring.js';
import { CareerPicker } from './market/CareerPicker.js';
import { PresetCard } from './market/PresetCard.js';
import { PresetDetails } from './market/PresetDetails.js';
import { ConfigurePresets } from './market/ConfigurePresets.js';
import { UpdatePreset } from './market/UpdatePreset.js';
import { marketRows, rowMembers, type MarketRow } from './market/marketRows.js';
import { marketSections } from './market/marketSections.js';

export function Market({
  data,
  mutate,
  headerLeading,
  configureConnection,
  careerTrigger = false,
  careerHandled,
}: {
  data: Snapshot;
  mutate: Mutate;
  headerLeading?: ReactNode;
  configureConnection: () => void;
  careerTrigger?: boolean;
  careerHandled?: () => void;
}) {
  const { state, error, refresh, run } = useMarket();
  const [downloaded, setDownloaded] = useState(false);
  const [profession, setProfession] = useState('');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [detail, setDetail] = useState<MarketRow>();
  const [configure, setConfigure] = useState<PresetInstallation[]>();
  const [editing, setEditing] = useState<Bot>();
  const [update, setUpdate] = useState<PresetInstallation>();
  const [busy, setBusy] = useState(false);
  const installations = state?.installations || [];
  const search = query.trim().toLocaleLowerCase();
  const visible = marketRows(state, downloaded)
    .filter(({ preset }) => {
      if (profession && !preset.professions.includes(profession)) return false;
      return (
        !search ||
        [preset.name, preset.role, preset.description, ...preset.skills.map((skill) => skill.name)]
          .join(' ')
          .toLocaleLowerCase()
          .includes(search)
      );
    })
    .sort(
      (a, b) =>
        a.preset.rank - b.preset.rank || a.preset.name.localeCompare(b.preset.name, 'zh-CN'),
    );
  const sections = marketSections(
    visible,
    profession
      ? (state?.professions || []).filter((item) => item.id === profession)
      : state?.professions || [],
    state?.preferences.professionIds || [],
    downloaded,
  );
  const selected = visible.filter((row) => selection.includes(row.key));
  const { hire, hiring } = usePresetHiring(installations, run, setConfigure);
  async function action(method: string, params?: Record<string, unknown>) {
    try {
      return await run(method, params);
    } catch {
      return undefined;
    }
  }
  const detailInstallation =
    detail &&
    (detail.installation
      ? installations.find((item) => item.id === detail.installation?.id)
      : installations.find(
          (item) =>
            item.source === detail.source &&
            item.preset.id === detail.preset.id &&
            item.preset.version === detail.preset.version,
        ));
  const outdated = detail
    ? rowMembers(detail, data.bots).filter((bot) => bot.preset?.version !== detail.preset.version)
    : [];
  function importPreset() {
    void action('market.import');
  }
  function checkCatalogUpdates() {
    setBusy(true);
    void action('market.refresh').finally(() => setBusy(false));
  }
  function showDownloaded() {
    setDownloaded(true);
    setSelection([]);
  }
  function showAllPresets() {
    setDownloaded(false);
    setSelection([]);
  }
  function hireSelected() {
    void hire(selected);
  }
  function hireRow(row: MarketRow) {
    void hire([row]);
  }
  function toggleSelection(key: string) {
    setSelection((values) =>
      values.includes(key) ? values.filter((id) => id !== key) : [...values, key],
    );
  }
  function refreshMarket() {
    void refresh();
  }
  function careerSaved() {
    careerHandled?.();
    setDownloaded(false);
    refreshMarket();
  }
  function hireDetail() {
    if (!detail) return;
    void hire([{ ...detail, installation: detailInstallation }]);
    setDetail(undefined);
  }
  function cancelDetailDownload() {
    if (detailInstallation) void action('market.cancel', { id: detailInstallation.id });
  }
  async function removeDetail() {
    await run('market.remove', { id: detailInstallation?.id });
    setDetail(undefined);
  }
  function openMember(bot: Bot) {
    setEditing(bot);
    setDetail(undefined);
  }
  function checkDetailUpdates() {
    if (!detail) return;
    void action('market.refresh').then((value) => {
      const latest = (value as MarketState | undefined)?.presets.find(
        (preset) => preset.id === detail.preset.id,
      );
      if (latest && detail.source === 'official') {
        setDetail({ ...detail, preset: latest, installation: undefined });
      }
    });
  }
  function updateDetail() {
    setUpdate(detailInstallation);
    setDetail(undefined);
  }
  function emptyDescription() {
    if (query || profession) return '尝试其他关键词或职业。';
    if (downloaded) return '返回全部预设，选择适合你的智能体。';
    return '通过内容验收的岗位会在这里上架，也可以导入本地预设包。';
  }
  function renderCatalog() {
    if (!state)
      return (
        <div aria-busy="true" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[1, 2, 3].map((id) => (
            <div key={id} className="h-56 rounded-2xl bg-slate-50" />
          ))}
        </div>
      );
    if (!visible.length)
      return (
        <Empty
          title={downloaded && !query && !profession ? '还没有下载的预设' : '暂时没有匹配的预设'}
          description={emptyDescription()}
          action={
            downloaded ? (
              <Button onClick={showAllPresets}>浏览全部预设</Button>
            ) : (
              <Button onClick={importPreset}>导入预设</Button>
            )
          }
        />
      );
    return sections.map((section) => {
      return (
        <section key={section.key} className="mb-9">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-balance text-base font-semibold text-slate-900">{section.title}</h2>
            <span className="text-xs tabular-nums text-slate-400">
              {section.rows.length} 个预设
            </span>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {section.rows.map((row) => (
              <PresetCard
                key={row.key}
                preset={row.preset}
                installation={row.installation}
                memberCount={rowMembers(row, data.bots).length}
                selected={selection.includes(row.key)}
                toggle={() => toggleSelection(row.key)}
                details={() => setDetail(row)}
                hiring={hiring}
                hire={() => hireRow(row)}
              />
            ))}
          </div>
        </section>
      );
    });
  }
  return (
    <PageSurface
      headerLeading={headerLeading}
      contentClassName="px-7 pb-8"
      header={
        <PageHeader
          title="智能体市场"
          action={
            <div className="flex gap-2">
              <Button onClick={importPreset}>
                <Upload size={15} />
                导入预设
              </Button>
              <Button disabled={busy} onClick={checkCatalogUpdates}>
                <RefreshCw size={15} />
                检查更新
              </Button>
              <Button
                variant={downloaded ? 'primary' : 'default'}
                aria-pressed={downloaded}
                onClick={showDownloaded}
              >
                <Download size={15} />
                已下载
              </Button>
            </div>
          }
        />
      }
    >
      <div className="mx-auto max-w-6xl">
        <ErrorNote error={error} />
        {downloaded && (
          <div className="mb-4">
            <Button variant="ghost" className="px-0" onClick={showAllPresets}>
              <ArrowLeft size={15} />
              返回全部预设
            </Button>
          </div>
        )}
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="relative min-w-52 flex-1">
            <Search size={16} className="absolute left-3 top-3 text-slate-400" />
            <input
              className={cn(inputClass, 'pl-10')}
              aria-label="搜索预设智能体"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索岗位、职责或技能"
            />
          </div>
          <select
            className={cn(inputClass, 'w-auto min-w-40')}
            aria-label="按职业筛选"
            value={profession}
            onChange={(event) => setProfession(event.target.value)}
          >
            <option value="">全部职业</option>
            {state?.professions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        {selection.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3">
            <p className="mr-auto text-sm text-blue-800">已选择 {selected.length} 个预设</p>
            <Button variant="ghost" onClick={() => setSelection([])}>
              取消选择
            </Button>
            <Button
              variant="primary"
              disabled={busy || hiring || !selected.length}
              onClick={hireSelected}
            >
              {hiring ? '准备中…' : `雇佣 ${selected.length} 位成员`}
            </Button>
          </div>
        )}
        {renderCatalog()}
      </div>
      <ModalPresence show={careerTrigger && !!state}>
        {careerTrigger && state && (
          <CareerPicker
            preferences={state.preferences}
            close={() => careerHandled?.()}
            saved={careerSaved}
          />
        )}
      </ModalPresence>
      <ModalPresence show={!!configure}>
        {configure && (
          <ConfigurePresets
            installations={configure}
            data={data}
            mutate={mutate}
            close={() => setConfigure(undefined)}
            created={refreshMarket}
          />
        )}
      </ModalPresence>
      <ModalPresence show={!!detail}>
        {detail && (
          <PresetDetails
            preset={detail.preset}
            installation={detailInstallation}
            bots={rowMembers(detail, data.bots)}
            close={() => setDetail(undefined)}
            hiring={hiring}
            hire={hireDetail}
            cancel={cancelDetailDownload}
            remove={removeDetail}
            openMember={openMember}
            checkUpdates={checkDetailUpdates}
            update={
              detailInstallation?.status === 'installed' && outdated.length
                ? updateDetail
                : undefined
            }
          />
        )}
      </ModalPresence>
      <ModalPresence show={!!editing}>
        {editing && (
          <BotEditor
            key={editing.id}
            bot={editing}
            data={data}
            mutate={mutate}
            close={() => setEditing(undefined)}
            configureConnection={configureConnection}
          />
        )}
      </ModalPresence>
      <ModalPresence show={!!update}>
        {update && (
          <UpdatePreset
            installation={update}
            previous={installations.filter(
              (item) =>
                item.source === update.source &&
                item.preset.id === update.preset.id &&
                item.preset.version !== update.preset.version &&
                data.bots.some((bot) => bot.preset?.installationId === item.id),
            )}
            bots={data.bots.filter(
              (bot) =>
                bot.preset?.presetId === update.preset.id &&
                bot.preset.source === update.source &&
                bot.preset.version !== update.preset.version,
            )}
            data={data}
            mutate={mutate}
            close={() => setUpdate(undefined)}
            applied={refreshMarket}
          />
        )}
      </ModalPresence>
    </PageSurface>
  );
}
