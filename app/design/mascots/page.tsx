import { notFound } from "next/navigation";
import MascotGallery from "@/app/design/MascotGallery";

/** Choose your companion, on sample data. Development only. */
export default function MascotsDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <MascotGallery />;
}
