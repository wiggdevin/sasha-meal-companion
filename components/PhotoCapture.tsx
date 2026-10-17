"use client";

import { useEffect, useRef, useState } from "react";
import { resizeImage } from "@/lib/media/resize";
import { shotTimeOf } from "@/lib/media/exif-time";
import type { PhotoTimes } from "@/lib/capture/shot-time";
import Button from "@/components/ui/Button";

/** The 512 px copy a plate photo keeps beside its entry (T2 D2); the full size stays 24 h. */
export const THUMBNAIL_RESIZE = { longEdge: 512, quality: 0.7 } as const;

/** What the phone knows about a shot beyond its pixels, read before the resize drops it (W125). */
export type PhotoMeta = { times: PhotoTimes; thumbnail: Blob | null };

/** The shot the user has taken: the resized blob, its preview URL, and the two flags the buttons read. */
function usePhotoShot(withThumbnail: boolean) {
  const [shot, setShot] = useState<Blob | null>(null);
  const [meta, setMeta] = useState<PhotoMeta>({ times: { exif: null, picked: null }, thumbnail: null });
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => () => { if (preview !== null) URL.revokeObjectURL(preview); }, [preview]);

  async function take(file: File) {
    setWorking(true);
    setFailed(false);
    // The camera hands the file over as the shot is taken; a library pick carries its own date.
    const picked = Number.isFinite(file.lastModified) && file.lastModified > 0
      ? new Date(file.lastModified) : new Date();
    try {
      const [resized, exif, thumbnail] = await Promise.all([
        resizeImage(file), shotTimeOf(file),
        withThumbnail ? resizeImage(file, THUMBNAIL_RESIZE).catch(() => null) : Promise.resolve(null),
      ]);
      setMeta({ times: { exif, picked }, thumbnail });
      setShot(resized);
      setPreview((old) => { if (old !== null) URL.revokeObjectURL(old); return URL.createObjectURL(resized); });
    } catch {
      setFailed(true);
    } finally {
      setWorking(false);
    }
  }

  return { shot, meta, preview, working, failed, take, clear: () => setShot(null) };
}

/** The preview and the buttons over it: take one, or use and retake the one the user has. */
function PhotoActions({
  shot, preview, label, busy, working, onTake, onUse, onRetake,
}: {
  shot: Blob | null;
  preview: string | null;
  label: string;
  busy: boolean;
  working: boolean;
  onTake: () => void;
  onUse: (shot: Blob) => void;
  onRetake: () => void;
}) {
  if (shot === null) {
    return (
      <Button variant="primary" size="lg" block status={working ? "pending" : undefined} disabled={busy}
        onClick={onTake}>
        {label}
      </Button>
    );
  }
  return (
    <>
      {preview !== null && (
        // rounded-[16px] is DESIGN.md rounded.md (line 87), also --radius-md in app/design-tokens.css line 71.
        // eslint-disable-next-line @next/next/no-img-element -- a blob: URL has no loader
        <img src={preview} alt="" className="w-full rounded-[16px]" style={{ maxHeight: 240, objectFit: "cover" }} />
      )}
      <div className="flex w-full flex-col items-center gap-2">
        <Button variant="primary" size="lg" block status={busy ? "pending" : undefined} onClick={() => onUse(shot)}>
          Use this photo
        </Button>
        <Button variant="tertiary" block disabled={busy} onClick={onRetake}>Take another</Button>
      </div>
    </>
  );
}

/**
 * The camera half of the label and plate methods — spec §6. `capture="environment"` opens the back
 * camera straight from the file input, so there is no live preview to build and no permission
 * prompt until the user taps. Every photo is re-encoded before it leaves the phone: that is the resize
 * and the EXIF strip in one step (architecture §4.2). Only the shot time is read off the original
 * first (W125), on the phone, and only the instant leaves it.
 */
export default function PhotoCapture({ label, onReady, busy = false, withThumbnail = false }: {
  label: string;
  /** `meta`: the shot time read off the original file, and the thumbnail when asked for. */
  onReady: (photo: Blob, meta: PhotoMeta) => void;
  busy?: boolean;
  /** Also make the 512 px copy a plate photo keeps (W125). */
  withThumbnail?: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const { shot, meta, preview, working, failed, take, clear } = usePhotoShot(withThumbnail);

  return (
    <div className="flex flex-col items-center gap-3">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";            // picking the same file twice must still fire
          if (file) void take(file);
        }}
      />

      <PhotoActions
        shot={shot} preview={preview} label={label} busy={busy} working={working}
        onTake={() => input.current?.click()}
        onUse={(photo) => onReady(photo, meta)}
        onRetake={() => { clear(); input.current?.click(); }}
      />

      {failed && (
        // #4a4c42 is DESIGN.md text-secondary (line 13).
        <p role="status" className="text-tiny font-normal text-graphite">
          That photo would not open. Try again.
        </p>
      )}
    </div>
  );
}
