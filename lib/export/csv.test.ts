import { describe, expect, it } from "vitest";
import { csvDocument, escapeCell, ODBL_NOTICE, toCsv } from "./csv";

describe("escapeCell", () => {
  it("prefixes the four formula characters with an apostrophe", () => {
    expect(escapeCell("=1+1")).toBe("'=1+1");
    expect(escapeCell("+44 7700")).toBe("'+44 7700");
    expect(escapeCell("-5")).toBe("'-5");
    expect(escapeCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("quotes a cell holding a comma, a quote or a newline", () => {
    expect(escapeCell("rice, cooked")).toBe('"rice, cooked"');
    expect(escapeCell('he said "hi"')).toBe('"he said ""hi"""');
    expect(escapeCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("quotes a prefixed formula cell that also holds a comma", () => {
    expect(escapeCell("=A1,B1")).toBe("\"'=A1,B1\"");
  });

  it("renders null and undefined as empty and numbers verbatim", () => {
    expect(escapeCell(null)).toBe("");
    expect(escapeCell(undefined)).toBe("");
    expect(escapeCell(0)).toBe("0");
    expect(escapeCell(-5)).toBe("'-5");
    expect(escapeCell(true)).toBe("true");
  });
});

describe("toCsv", () => {
  it("writes the header in column order and CRLF line endings", () => {
    const rows = [
      { local_date: "2026-09-10", tz: "America/Los_Angeles", note: "felt fine" },
      { local_date: "2026-09-11", tz: "America/Los_Angeles", note: "=bad" },
    ];
    expect(toCsv(rows, ["local_date", "tz", "note"])).toBe(
      "local_date,tz,note\r\n" +
        "2026-09-10,America/Los_Angeles,felt fine\r\n" +
        "2026-09-11,America/Los_Angeles,'=bad\r\n"
    );
  });

  it("emits a header-only document for no rows", () => {
    expect(toCsv([], ["a", "b"])).toBe("a,b\r\n");
  });

  it("writes an empty cell for a column a row does not carry", () => {
    expect(toCsv([{ a: 1 }], ["a", "b"])).toBe("a,b\r\n1,\r\n");
  });
});

describe("csvDocument", () => {
  it("writes the header then one line per row, CRLF, in column order", () => {
    expect(csvDocument(["a", "b"], [[1, "x"], [2, null]]))
      .toBe("a,b\r\n1,x\r\n2,\r\n");
  });

  it("prefixes a leading formula character in a row cell", () => {
    expect(csvDocument(["food_name"], [["=SUM(A1)"]]))
      .toBe("food_name\r\n'=SUM(A1)\r\n");
  });

  it("appends each notice as a trailing comment line", () => {
    expect(csvDocument(["a"], [["x"]], [ODBL_NOTICE]))
      .toBe(`a\r\nx\r\n# ${ODBL_NOTICE}\r\n`);
  });

  it("emits a header-only document for no rows", () => {
    expect(csvDocument(["a", "b"], [])).toBe("a,b\r\n");
  });
});
