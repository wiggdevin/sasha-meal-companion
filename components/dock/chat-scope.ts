/**
 * Where an ask comes from (U22, 2026-10-04; owner: "every instance of AI input … should be
 * component-bound, page-bound or global-bound … if you're on a page and using the bottom navigation
 * and you want to ask AI, that's probably going to be because the user has specific questions …
 * about something on the page").
 *
 * The dock's ask bar is page-bound on a dock page and global on /coach. Every turn carries the
 * scope; the backend narrows the allowed actions and the viewed date to it (PR #355). Its shape is
 * the backend's `CoachScope` minus the meal-card kind; each object is strict there, so only these
 * keys are ever sent.
 */
import { COACH_PAGES, type CoachPage, type CoachScope } from "@/lib/coach/types";
import { parseUrlDate } from "@/lib/url-date";

export const CHAT_PAGES = COACH_PAGES;
export type ChatPage = CoachPage;
export type ChatScope = Extract<CoachScope, { kind: "page" } | { kind: "global" }>;

const PAGE_FOR_PATH: Record<string, ChatPage> = {
  "/": "today", "/body": "body", "/foods": "foods", "/settings": "settings",
};

const PAGE_LABEL: Record<ChatPage, string> = {
  today: "Today", body: "Body", foods: "Foods", settings: "Settings",
};

/** The dock page a path belongs to (a sub-path counts as its tab), or null for /coach and others. */
export function pageForPath(pathname: string): ChatPage | null {
  if (PAGE_FOR_PATH[pathname]) return PAGE_FOR_PATH[pathname];
  const tab = Object.keys(PAGE_FOR_PATH).find((path) => path !== "/" && pathname.startsWith(`${path}/`));
  return tab ? PAGE_FOR_PATH[tab] : null;
}

/**
 * The scope of an ask made from `pathname`. Today names the date being viewed (its `?d=`, else
 * `today`, the phone's local date), so "move my lunch" means the day on screen.
 */
export function scopeForLocation(pathname: string, search: string, today: string): ChatScope {
  const page = pageForPath(pathname);
  if (!page) return { kind: "global" };
  if (page !== "today") return { kind: "page", page };
  return { kind: "page", page, date: parseUrlDate(new URLSearchParams(search).get("d")) ?? today };
}

/** The header chip: where the next answer is about. */
export function scopeLabel(scope: ChatScope): string {
  return scope.kind === "global" ? "Whole app" : `On ${PAGE_LABEL[scope.page]}`;
}

/** The phone's local calendar date (YYYY-MM-DD). */
export function localIsoDate(at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
