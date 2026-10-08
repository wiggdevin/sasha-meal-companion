import { notFound } from "next/navigation";
import MealCardsGallery from "@/app/design/MealCardsGallery";

/** Every Today meal card state on sample data, for review at phone width. Development only. */
export default function MealCardsDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <MealCardsGallery />;
}
