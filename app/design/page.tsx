import { notFound } from "next/navigation";
import DesignGallery from "@/app/design/DesignGallery";
import CardsGallery from "@/app/design/CardsGallery";

/**
 * The visual contract: every primitive in components/ui in every variant, on the real ground.
 * Development only — production answers 404 (docs/plans, design system slice 1, 2026-09-22). The
 * Cards section (app/design/CardsGallery.tsx) shows the CardFrame sizes, levels and tones.
 */
export default function DesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <>
      <DesignGallery />
      <div className="mx-auto flex w-full max-w-md flex-col px-4 pb-8">
        <CardsGallery />
      </div>
    </>
  );
}
