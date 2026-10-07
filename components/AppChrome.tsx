"use client";

import { usePathname } from "next/navigation";
import TabBar from "@/components/TabBar";

const PRIMARY_ROUTES = ["/body", "/foods", "/coach", "/settings"] as const;

export function isPrimaryRoute(pathname: string): boolean {
  if (pathname === "/") return true;
  return PRIMARY_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export default function AppChrome() {
  const pathname = usePathname();
  if (!isPrimaryRoute(pathname)) return null;

  return <TabBar />;
}
