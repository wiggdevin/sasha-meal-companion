import type { ReactNode } from "react";

/** Selection pill with the app-wide minimum touch target applied to the button itself. */
export default function EditorPill({ active, onClick, children }: {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="pill inline-flex">
      <button type="button" onClick={onClick} aria-pressed={active}
        className={`pill-in tap flex items-center justify-center px-4 text-tiny font-normal ${
          active ? "text-on-primary" : "text-graphite"
        }`}
        style={{
          minHeight: 44,
          minWidth: 44,
          background: active ? "var(--grad-ink)" : undefined,
        }}>
        {children}
      </button>
    </div>
  );
}
