"use client";

/**
 * The one line the body-profile surfaces show when the shared IndexedDB read itself failed (Sol
 * third round, finding 6): the message plus a 44 px "Try again". Extracted so Settings'
 * `EstimatorCard`, Settings' fields and `/body` cannot drift apart — or push their own components
 * over the house line limit.
 */
import { PROFILE_READ_ERROR } from "@/lib/body-profile-client";
import Notice from "@/components/ui/Notice";

export default function ProfileReadAlert({ onRetry, pad = false }: {
  onRetry: () => void;
  /** The `/body` header sits flush to the gutter; Settings' card is already padded. */
  pad?: boolean;
}) {
  return (
    <Notice tone="error" title={PROFILE_READ_ERROR} className={pad ? "px-1" : ""}
      action={{ label: "Try again", onClick: onRetry }} />
  );
}
