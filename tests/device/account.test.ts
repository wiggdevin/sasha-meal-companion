import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountChanged, AccountNotBound, accountHandle, accountKey, assertCurrent, bindAccount,
  currentAccountOrNull, isCurrent, markAccountReady, onAccountGone, onAccountReady, unbindAccount,
} from "@/lib/device/account";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => { unbindAccount(); });

describe("account binding", () => {
  it("throws AccountNotBound when nothing is bound", () => {
    expect(() => accountHandle()).toThrow(AccountNotBound);
    expect(currentAccountOrNull()).toBeNull();
  });

  it("gives the bound user id and a fresh epoch", () => {
    const h = bindAccount(A);
    expect(accountHandle()).toEqual(h);
    expect(h.userId).toBe(A);
  });

  it("keeps the same handle when the same user binds again (token refresh)", () => {
    const h1 = bindAccount(A);
    const h2 = bindAccount(A);
    expect(h2).toEqual(h1);
    expect(() => assertCurrent(h1)).not.toThrow();
  });

  it("makes an old handle stale after a switch, even back to the same user", () => {
    const a1 = bindAccount(A);
    bindAccount(B);
    expect(() => assertCurrent(a1)).toThrow(AccountChanged);
    unbindAccount();
    const a2 = bindAccount(A);
    expect(isCurrent(a1)).toBe(false);
    expect(isCurrent(a2)).toBe(true);
  });

  it("fires ready only after markAccountReady, and at once for a late subscriber", () => {
    const early = vi.fn();
    const stop = onAccountReady(early);
    const h = bindAccount(A);
    expect(early).not.toHaveBeenCalled();
    markAccountReady(h);
    expect(early).toHaveBeenCalledWith(h);
    const late = vi.fn();
    const stopLate = onAccountReady(late);
    expect(late).toHaveBeenCalledWith(h);
    stop();
    stopLate();
  });

  it("fires ready once per bind, however often ready is marked", () => {
    const fn = vi.fn();
    const stop = onAccountReady(fn);
    const h = bindAccount(A);
    markAccountReady(h);
    markAccountReady(bindAccount(A));
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("refuses markAccountReady with a stale handle", () => {
    const a = bindAccount(A);
    bindAccount(B);
    expect(() => markAccountReady(a)).toThrow(AccountChanged);
  });

  it("fires gone with the previous handle on unbind and on switch", () => {
    const gone = vi.fn();
    const stop = onAccountGone(gone);
    const a = bindAccount(A);
    bindAccount(B);
    expect(gone).toHaveBeenCalledWith(a);
    stop();
  });

  it("builds account-scoped storage keys", () => {
    const h = bindAccount(A);
    expect(accountKey(h, "coach:t1")).toBe(`smc:u:${A}:coach:t1`);
  });
});
