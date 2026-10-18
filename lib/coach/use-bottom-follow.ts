"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  capturePrependAnchor as captureAnchor,
  restorePrependAnchor as restoreAnchor,
  type PrependAnchor,
} from "@/lib/coach/thread-history";

const BOTTOM_EPSILON = 1; /** Further up than this a reader is re-reading: new content never pulls them down (the pill offers it). */
export const FOLLOW_SLACK = 48;

function gap(element: HTMLElement): number { return element.scrollHeight - element.scrollTop - element.clientHeight; }

export function useBottomFollow(contentVersion: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [hasNewMessage, setHasNewMessage] = useState(false);
  const isMounted = useRef(false);
  const isPinned = useRef(true);
  const prependAnchor = useRef<PrependAnchor | null>(null); const prependInFlight = useRef(false);
  const shouldFollow = useRef<boolean | null>(null);
  const scrollToBottom = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    prependAnchor.current = null; prependInFlight.current = false;
    element.scrollTop = element.scrollHeight;
    isPinned.current = true;
    setHasNewMessage(false);
  }, []);
  const captureBeforeUpdate = useCallback((force = false) => {
    const element = scroller.current;
    if (prependInFlight.current) return;
    prependAnchor.current = null;
    shouldFollow.current = force || !element || isPinned.current || gap(element) <= FOLLOW_SLACK;
  }, []);
  const capturePrependAnchor = useCallback(() => {
    const element = scroller.current;
    prependAnchor.current = element ? captureAnchor(element) : null;
    prependInFlight.current = prependAnchor.current !== null;
  }, []);
  const cancelPrependAnchor = useCallback(() => {
    prependAnchor.current = null; prependInFlight.current = false;
  }, []);
  const applyPrependAnchor = useCallback(() => {
    const element = scroller.current;
    if (element && prependAnchor.current) restoreAnchor(element, prependAnchor.current);
  }, []);
  const restorePrependAnchor = useCallback(() => {
    applyPrependAnchor(); prependInFlight.current = false;
  }, [applyPrependAnchor]);
  useLayoutEffect(() => {
    if (!isMounted.current) {
      isMounted.current = true;
      scrollToBottom();
      return;
    }
    if (prependAnchor.current) { shouldFollow.current = null; return; }
    const follow = shouldFollow.current ?? isPinned.current;
    shouldFollow.current = null;
    if (follow) scrollToBottom();
    else {
      isPinned.current = false;
      setHasNewMessage(true);
    }
  }, [contentVersion, scrollToBottom]);
  useLayoutEffect(() => {
    const element = content.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (prependAnchor.current) applyPrependAnchor();
      else if (isPinned.current) scrollToBottom();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [applyPrependAnchor, scrollToBottom]);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    if (prependAnchor.current) {
      const expected = prependAnchor.current.scrollTop
        + element.scrollHeight - prependAnchor.current.scrollHeight;
      if (Math.abs(element.scrollTop - expected) > BOTTOM_EPSILON) {
        prependAnchor.current = null; prependInFlight.current = false;
      }
    }
    const atBottom = gap(element) <= BOTTOM_EPSILON;
    isPinned.current = atBottom;
    if (atBottom) setHasNewMessage(false);
  }, []);
  return { cancelPrependAnchor, captureBeforeUpdate, capturePrependAnchor, content, hasNewMessage,
    onScroll, restorePrependAnchor, scroller, scrollToBottom };
}
