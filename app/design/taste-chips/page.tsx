import { notFound } from "next/navigation";
import TasteChipsGallery from "@/app/design/TasteChipsGallery";

/** The coach taste-chip confirm card and its Undo-list card, on fixtures. Development only. */
export default function TasteChipsDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <TasteChipsGallery />;
}
