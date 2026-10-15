import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { X, LoaderCircle } from "lucide-react";
import { errorMessage } from "./api.js";
import { useModalVisible } from "./ModalPresence.js";
import { cn } from "./classNames.js";
import { Button, ErrorNote } from "./controls.js";
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const visible = useModalVisible();
  return (
    <Dialog.Root open={open && visible} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-slate-950/35" />
        <Dialog.Content
          className={cn(
            "dialog-content fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%_-_2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-6 shadow-xl focus:outline-none",
            wide ? "max-w-2xl" : "max-w-lg",
          )}
        >
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="min-w-0 [overflow-wrap:anywhere]">
              <Dialog.Title className="text-balance text-lg font-semibold text-slate-900">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-2 text-pretty text-sm leading-6 text-slate-500">
                  {description}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}设置</Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" aria-label="关闭对话框" className="size-8 min-h-8 shrink-0 p-0">
                <X size={18} />
              </Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Confirm({
  title,
  description,
  actionLabel = "确认",
  onConfirm,
  children,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onConfirm: () => Promise<unknown>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setPending(true);
    setError("");
    try {
      await onConfirm();
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!pending) {
          setOpen(value);
          setError("");
        }
      }}
    >
      <AlertDialog.Trigger asChild>{children}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay fixed inset-0 z-40 bg-slate-950/35" />
        <AlertDialog.Content className="dialog-content fixed left-1/2 top-1/2 z-50 w-[calc(100%_-_2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-6 shadow-xl">
          <AlertDialog.Title className="text-balance text-lg font-semibold">{title}</AlertDialog.Title>
          <AlertDialog.Description className="my-3 text-pretty text-sm leading-6 text-slate-500">
            {description}
          </AlertDialog.Description>
          <ErrorNote error={error} />
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={pending}>取消</Button>
            </AlertDialog.Cancel>
            <Button variant="danger" disabled={pending} onClick={() => void submit()}>
              {pending && <LoaderCircle size={16} />} {actionLabel}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
