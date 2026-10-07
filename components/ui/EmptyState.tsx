import type { ReactNode } from "react";
import Surface from "@/components/ui/Surface";

/** A screen or section with nothing in it yet: what it will hold and the one way to start. */
export default function EmptyState({ icon, title, body, action }: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <Surface className="flex flex-col items-center gap-2 px-5 py-6 text-center">
      {icon && <span className="flex h-11 w-11 items-center justify-center rounded-full well text-muted">{icon}</span>}
      <h2 className="section-title m-0 text-heading-sm font-semibold leading-heading-sm tracking-heading-sm">{title}</h2>
      {body && <p className="m-0 text-caption text-muted">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </Surface>
  );
}
