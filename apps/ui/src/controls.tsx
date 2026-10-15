import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "./classNames.js";
export function Button({
  className,
  variant = "default",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger";
}) {
  return (
    <button
      className={cn(
        "inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-40",
        variant === "primary" && "bg-blue-600 text-white hover:bg-blue-700",
        variant === "default" && "border border-black/8 bg-white text-slate-600 hover:bg-slate-50",
        variant === "ghost" && "text-slate-500 hover:bg-black/4 hover:text-slate-800",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid content-start gap-1.5 text-sm font-medium text-slate-700">
      {label}
      {children}
      {hint && <span className="text-xs font-normal leading-5 text-slate-500">{hint}</span>}
    </label>
  );
}
export const inputClass =
  "w-full min-h-10 rounded-lg border border-black/10 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:bg-slate-50";
export function ErrorNote({ error }: { error?: string }) {
  return error ? (
    <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-pretty text-sm text-red-700">
      {error}
    </p>
  ) : null;
}
