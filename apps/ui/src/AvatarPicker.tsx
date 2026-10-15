import { useState } from "react";
import { Upload } from "lucide-react";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Button, ErrorNote, cn } from "./components.js";
import { Avatar, avatarChoices } from "./Avatar.js";

export function AvatarPicker({ value, onChange, mutate }: {
  value: string; onChange: (value: string) => void; mutate: Mutate;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function upload() {
    setBusy(true);
    setError("");
    try {
      const result = await mutate<{ avatar?: string }>("avatars.import", {});
      if (result?.avatar) onChange(result.avatar);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <fieldset>
    <legend className="mb-3 text-sm font-medium text-slate-700">头像</legend>
    <div className="flex flex-wrap items-center gap-3">
      {avatarChoices.map((choice) => <button key={choice.id} type="button" aria-label={`选择${choice.name}头像`}
        aria-pressed={value === choice.id} onClick={() => onChange(choice.id)}
        className={cn("rounded-2xl border-2 p-1", value === choice.id ? "border-blue-600" : "border-transparent hover:border-slate-200")}>
        <Avatar avatar={choice.id} className="size-12" />
      </button>)}
      {value.startsWith("data:image/") && <Avatar avatar={value} className="size-14 ring-2 ring-blue-600" />}
      <Button type="button" disabled={busy} onClick={() => void upload()}><Upload size={15} />{busy ? "导入中…" : "上传头像"}</Button>
    </div>
    <ErrorNote error={error} />
  </fieldset>;
}
