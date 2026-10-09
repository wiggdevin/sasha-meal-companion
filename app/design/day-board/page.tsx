import { notFound } from "next/navigation";
import DayBoardGallery from "@/app/design/DayBoardGallery";

/** Every Day card board state on sample data, for review at phone width. Development only. */
export default function DayBoardDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DayBoardGallery />;
}
