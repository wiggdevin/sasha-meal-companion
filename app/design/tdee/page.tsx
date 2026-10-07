import { notFound } from "next/navigation";
import TdeeGallery from "@/app/design/TdeeGallery";

/** The burn estimate in every engine phase, and the "day fully logged" control. Development only. */
export default function TdeeDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <TdeeGallery />;
}
