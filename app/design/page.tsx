import { notFound } from "next/navigation";
import DesignGallery from "@/app/design/DesignGallery";

/**
 * The visual contract: every primitive in components/ui in every variant, on the real ground.
 * Development only — production answers 404 (docs/plans, design system slice 1, 2026-09-22).
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DesignGallery />;
}
