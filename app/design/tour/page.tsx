import { notFound } from "next/navigation";
import TourGallery from "@/app/design/TourGallery";

/** "How Sasha works", the first-run overview: every step's demo, moving and still. Development only. */
export default function TourDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <TourGallery />;
}
