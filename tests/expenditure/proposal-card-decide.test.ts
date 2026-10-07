// tests/expenditure/proposal-card-decide.test.ts
//
// F-059 / F-062: ProposalCard's decide() had a try/finally with no catch, so a
// rejected decideProposalOnline() (offline, a 5xx, or a 409 stale-proposal
// conflict) propagated as an unhandled promise rejection with nothing shown
// on screen. decideErrorMessage is the pure piece of that fix: given the
// thrown error, what copy should the card show. It is exported the same way
// deltaSentence already is, so it is testable without a DOM
// (@testing-library/react is not installed, per tests/expenditure/card-copy.test.ts).
import { describe, expect, it } from "vitest";
import { decideErrorMessage } from "@/components/ProposalCard";

describe("decideErrorMessage", () => {
  it("names a stale/superseded proposal on a 409 conflict", () => {
    expect(decideErrorMessage(new Error("decide failed: 409")))
      .toBe("This proposal changed — reload to see the latest.");
  });

  it("gives a generic retry message for any other failure", () => {
    expect(decideErrorMessage(new Error("decide failed: 500")))
      .toBe("Couldn't save. Try again.");
    expect(decideErrorMessage(new Error("Needs a connection")))
      .toBe("Couldn't save. Try again.");
    expect(decideErrorMessage("not an Error instance"))
      .toBe("Couldn't save. Try again.");
  });
});
