import { describe, expect, it } from "vitest";
import { checkRecipeUrl, isPrivateAddress } from "@/lib/server/recipe-url";

describe("recipe link guard", () => {
  it("blocks private, loopback, link-local and metadata addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254",
      "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });
  it("accepts only plain https links to a named host", () => {
    expect(checkRecipeUrl("https://www.example.com/recipe").hostname).toBe("www.example.com");
    for (const bad of ["http://example.com", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x",
      "https://user:pw@example.com", "https://example.com:8443/x", "file:///etc/passwd", "not a url"]) {
      expect(() => checkRecipeUrl(bad), bad).toThrow();
    }
  });
});

describe("recipe link guard, IPv6 forms that embed IPv4", () => {
  it("blocks NAT64, 6to4, Teredo, IPv4-compatible and site-local", () => {
    for (const address of ["64:ff9b::7f00:1", "64:ff9b:1::a00:1", "2002:7f00:1::", "2001:0:4136:e378::1",
      "2001::1", "::127.0.0.1", "::7f00:1", "fec0::1", "2001:db8::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });
});

describe("recipe link guard, canonical IPv6 and local names", () => {
  it("blocks loopback and mapped-private spellings a string prefix would miss", () => {
    for (const address of ["0::1", "0:0:0:0:0:0:0:1", "0:0:0:0:0:ffff:127.0.0.1", "0:0:0:0:0:FFFF:7f00:1",
      "::ffff:a9fe:a9fe", "0000:0000:0000:0000:0000:ffff:10.0.0.1", "0::", "FE80::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress("::ffff:93.184.216.34")).toBe(false);
    expect(isPrivateAddress("0:0:0:0:0:ffff:5db8:d822")).toBe(false);
  });
  it("refuses *.localhost and a trailing-dot localhost", () => {
    for (const bad of ["https://app.localhost/x", "https://localhost./x", "https://A.LOCALHOST/x"]) {
      expect(() => checkRecipeUrl(bad), bad).toThrow();
    }
  });
});
