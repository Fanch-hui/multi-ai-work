import { Trash2 } from 'lucide-react';
import type { Artifact } from '../../../src/domain/types.js';
import type { Mutate } from './store.js';
import { Button, Confirm } from './components.js';

export default function DeleteArtifactButton({
  artifact,
  mutate,
  onDeleted,
  labeled,
}: {
  artifact: Artifact;
  mutate: Mutate;
  onDeleted: () => void;
  labeled?: boolean;
}) {
  async function remove() {
    await mutate('artifacts.delete', { id: artifact.id });
    onDeleted();
  }
  return (
    <Confirm
      title={`删除“${artifact.name}”？`}
      actionLabel="删除成果"
      onConfirm={remove}
      description="删除此成果记录及 App 保存的文件副本，工作区原文件保留。如有历史版本，库中将显示上一版。"
    >
      <Button
        variant="ghost"
        aria-label={`删除${artifact.name}`}
        title="删除成果"
        className={
          labeled ? 'text-red-600' : 'size-8 min-h-8 p-0 text-slate-400 hover:text-red-600'
        }
      >
        <Trash2 size={15} />
        {labeled && '删除成果'}
      </Button>
    </Confirm>
  );
}
