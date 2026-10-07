import { notFound } from "next/navigation";
import ShopGallery from "@/app/design/ShopGallery";

/** Sprout's shop, wardrobe and Seeds, on sample data. Development only. */
export default function ShopDesignPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ShopGallery />;
}
