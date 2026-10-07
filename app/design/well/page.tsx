import { notFound } from "next/navigation";
import WellGallery from "@/app/design/WellGallery";

/** The Day card's glass well and Sprout, on sample days and hours. Development only. */
export default function WellDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <WellGallery />;
}
