"use client";

/**
 * The picture at the left of a logged card: the user's own plate photo when the capture kept a
 * thumbnail (W125, T2), else a snack's illustrative art, else nothing.
 */
import Image from "next/image";
import dark from "./AfterDarkCards.module.css";

export default function EntryArt({ snack, thumb, image }: {
  snack: boolean;
  /** A signed URL to the kept thumbnail, from `useEntryThumbnail`. */
  thumb: string | null;
  /** A snack's illustrative art, when its foods support one. */
  image: string | null;
}) {
  if (thumb) {
    return (
      <span className={dark.snackArt} aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed Storage URL */}
        <img src={thumb} alt="" className="absolute inset-0 h-full w-full object-cover" />
      </span>
    );
  }
  if (!snack) return null;
  return (
    <span className={dark.snackArt} aria-hidden="true">
      {image && <Image src={image} alt="" fill sizes="56px" />}
    </span>
  );
}
