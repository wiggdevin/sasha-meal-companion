"use client";

import { useEffect, useRef, useState } from "react";
import { resizeImage } from "@/lib/media/resize";
import Button from "@/components/ui/Button";

/** The shot the user has taken: the resized blob, its preview URL, and the two flags the buttons read. */
function usePhotoShot() {
  const [shot, setShot] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => () => { if (preview !== null) URL.revokeObjectURL(preview); }, [preview]);

  async function take(file: File) {
    setWorking(true);
    setFailed(false);
    try {
      const resized = await resizeImage(file);
      setShot(resized);
      setPreview((old) => { if (old !== null) URL.revokeObjectURL(old); return URL.createObjectURL(resized); });
    } catch {
      setFailed(true);
    } finally {
      setWorking(false);
    }
  }

  return { shot, preview, working, failed, take, clear: () => setShot(null) };
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
 * and the EXIF strip in one step (architecture §4.2).
 */
export default function PhotoCapture({ label, onReady, busy = false }: {
  label: string;
  onReady: (photo: Blob) => void;
  busy?: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const { shot, preview, working, failed, take, clear } = usePhotoShot();

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
        onUse={onReady}
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
