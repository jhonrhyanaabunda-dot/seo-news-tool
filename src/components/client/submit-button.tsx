"use client";

import { useFormStatus } from "react-dom";
import clsx from "clsx";

export function SubmitButton({ children, pendingText, className = "btn-primary", confirm, name, value, title }: { children: React.ReactNode; pendingText?: string; className?: string; confirm?: string; name?: string; value?: string; title?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      title={title}
      disabled={pending}
      aria-disabled={pending}
      className={clsx(className)}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (pendingText ?? "Working…") : children}
    </button>
  );
}
