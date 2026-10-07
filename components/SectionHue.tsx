"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { sectionFor } from "@/lib/design/section";

/** Writes the current section onto <html data-section>; app/globals.css picks the hue from it. */
export default function SectionHue() {
  const pathname = usePathname();
  useEffect(() => {
    document.documentElement.dataset.section = sectionFor(pathname);
  }, [pathname]);
  return null;
}
