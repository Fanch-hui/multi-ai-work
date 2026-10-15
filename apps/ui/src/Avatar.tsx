import type { Bot } from "../../../src/domain/types.js";
import { cn } from "./classNames.js";

export const avatarChoices = [
  { id: "cat", name: "小猫" },
  { id: "fox", name: "小狐狸" },
  { id: "panda", name: "熊猫" },
  { id: "owl", name: "猫头鹰" },
];

export function Avatar({ bot, name, avatar, small, className }: {
  bot?: Bot; name?: string; color?: string; avatar?: string; small?: boolean; className?: string;
}) {
  const label = name || bot?.name || "智能体";
  const selected = avatar ?? bot?.avatar;
  const fallback = avatarChoices[Array.from(label).reduce((sum, char) => sum + char.charCodeAt(0), 0) % avatarChoices.length]!.id;
  const source = selected?.startsWith("data:image/") ? selected
    : `${import.meta.env.BASE_URL}avatars/${avatarChoices.some((choice) => choice.id === selected) ? selected : fallback}.png`;
  return <span className={cn("inline-flex shrink-0 overflow-hidden rounded-2xl bg-slate-50", small ? "size-7 rounded-lg" : "size-11", className)}>
    <img src={source} alt="" className="size-full object-cover" />
  </span>;
}

export function UserAvatar({ avatar, className }: { avatar?: string; className?: string }) {
  return <Avatar name="你" avatar={avatar ?? "cat"} className={className} />;
}

export default Avatar;
