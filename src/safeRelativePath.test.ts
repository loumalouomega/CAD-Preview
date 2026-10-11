import { describe, it, expect } from "vitest";
import { isSafeRelativePath } from "./safeRelativePath";

describe("isSafeRelativePath", () => {
  it("accepts plain relative paths beside the model", () => {
    for (const ok of ["a.mtl", "sub/a.mtl", "sub\\a.png", "./a.bin", "my%20file.mtl", "a..b.mtl"]) {
      expect(isSafeRelativePath(ok), ok).toBe(true);
    }
  });

  it("refuses schemes, absolute paths and anything that climbs out of the folder", () => {
    for (const bad of ["", "http://x/a.mtl", "file:///etc/passwd", "data:text/plain,hi", "/etc/passwd", "\\\\server\\share", "C:\\a.mtl", "C:/a.mtl", "../a.mtl", "a/../../b.mtl", "%2e%2e/a.mtl", "a/%2E%2E/b", "%zz"]) {
      expect(isSafeRelativePath(bad), bad).toBe(false);
    }
  });
});
