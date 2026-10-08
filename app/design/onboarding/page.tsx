import { Suspense } from "react";
import { notFound } from "next/navigation";
import OnboardingGallery from "@/components/Onboarding/OnboardingGallery";

/** Onboarding v2's real shell with local sample data (no account, no writes). Development only. */
export default function OnboardingDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <Suspense><OnboardingGallery /></Suspense>;
}
