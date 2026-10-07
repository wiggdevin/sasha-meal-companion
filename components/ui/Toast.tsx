import type { ReactNode } from "react";

/** A short confirmation on a glass pill, announced as a status. The caller decides when it goes. */
export default function Toast({ children, className = "", role = "status" }: {
  children: ReactNode;
  className?: string;
  role?: "status" | "alert";
}) {
  return (
    <div role={role} aria-atomic="true"
      className={`toast pill-in inline-flex min-h-11 items-center px-4 text-caption text-charcoal ${className}`.trim()}>
      {children}
    </div>
  );
}
