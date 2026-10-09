import { notFound } from "next/navigation";
import DayOverviewGallery from "@/app/design/DayOverviewGallery";

/** Every Day card Overview face state on sample data, for review at phone width. Development only. */
export default function DayOverviewDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DayOverviewGallery />;
}
