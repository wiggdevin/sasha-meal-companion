import { notFound } from "next/navigation";
import AwardsGallery from "@/app/design/AwardsGallery";

/** Sprout's awards and the well's messages, on sample data. Development only. */
export default function AwardsDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AwardsGallery />;
}
