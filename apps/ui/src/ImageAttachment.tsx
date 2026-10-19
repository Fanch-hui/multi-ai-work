import { useEffect, useState } from 'react';
import { ImageIcon, LoaderCircle, X } from 'lucide-react';
import type { Artifact } from '../../../src/domain/types.js';
import { errorMessage, request } from './api.js';
import { ErrorNote, Modal } from './components.js';

export function isImageAttachment(artifact: Artifact) {
  return artifact.mimeType.startsWith('image/');
}

export function ImageAttachment({
  artifact,
  conversationId,
  onRemove,
  disabled,
}: {
  artifact: Artifact;
  conversationId?: string;
  onRemove?: () => void;
  disabled?: boolean;
}) {
  const { url, error } = useArtifactImage(artifact.id, conversationId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="relative w-28 max-w-full rounded-xl border border-slate-200 bg-white p-1">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`查看图片 ${artifact.name}`}
          className="grid w-full gap-1 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-blue-500"
        >
          {url ? (
            <img src={url} alt={artifact.name} className="h-20 w-full rounded-lg object-cover" />
          ) : (
            <span className="flex h-20 items-center justify-center rounded-lg bg-slate-50 text-slate-400">
              {error ? (
                <ImageIcon size={24} />
              ) : (
                <LoaderCircle size={20} aria-label="正在读取图片" />
              )}
            </span>
          )}
          <span className="truncate px-1 text-xs text-slate-600" title={artifact.name}>
            {artifact.name}
          </span>
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            aria-label={`取消附加 ${artifact.name}`}
            className="absolute -right-1 -top-1 rounded-full border border-slate-200 bg-white p-1 text-slate-500 shadow-sm hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-500"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <Modal open={open} onOpenChange={setOpen} title={artifact.name} wide>
        <ErrorNote error={error} />
        {url && (
          <img
            src={url}
            alt={artifact.name}
            className="mx-auto max-h-[70vh] max-w-full object-contain"
          />
        )}
      </Modal>
    </>
  );
}

export function ArtifactImagePreview({ artifact }: { artifact: Artifact }) {
  const { url, error } = useArtifactImage(artifact.id);
  return (
    <>
      <ErrorNote error={error} />
      {url ? (
        <img
          src={url}
          alt={artifact.name}
          className="mx-auto max-h-[70vh] max-w-full object-contain"
        />
      ) : (
        !error && (
          <p role="status" className="py-6 text-sm text-slate-500">
            正在读取图片…
          </p>
        )
      )}
    </>
  );
}

function useArtifactImage(id: string, conversationId?: string) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setUrl('');
    setError('');
    void request<{ mimeType: string; data: string }>('artifacts.preview', { id, conversationId })
      .then((result) => {
        if (!active) return;
        const bytes = Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0));
        objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
        setUrl(objectUrl);
      })
      .catch((cause) => {
        if (active) setError(errorMessage(cause));
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, conversationId]);
  return { url, error };
}
