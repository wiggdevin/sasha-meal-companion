"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { browserClient } from "@/lib/supabase/client";

/** The Today header's profile avatar: the account initial in a glass circle. Opens settings for now;
    a quick-preferences popover replaces the link later. */
export default function HeaderAvatar() {
  const [initial, setInitial] = useState("S");

  useEffect(() => {
    let live = true;
    // The initial is decoration: a missing session or client keeps the "S" fallback.
    void Promise.resolve().then(() => browserClient().auth.getSession()).then(({ data }) => {
      const first = data.session?.user.email?.trim().charAt(0);
      if (live && first) setInitial(first.toUpperCase());
    }, () => {});
    return () => { live = false; };
  }, []);

  return (
    <Link href="/settings" aria-label="Profile and preferences" className="tap inline-flex items-center justify-center">
      <span className="pill inline-flex">
        <span className="pill-in grid size-10 place-items-center rounded-full text-body-sm font-medium text-charcoal">
          {initial}
        </span>
      </span>
    </Link>
  );
}
