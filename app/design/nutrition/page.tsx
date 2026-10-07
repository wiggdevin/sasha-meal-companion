import { notFound } from "next/navigation";
import NutritionGallery from "@/app/design/NutritionGallery";

/** The nutrition display system: every form, badge and recipe-card layout. Development only. */
export default function NutritionDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <NutritionGallery />;
}
