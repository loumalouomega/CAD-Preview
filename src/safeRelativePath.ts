/**
 * Whether a URI named by an untrusted model file (a glTF buffer, an OBJ
 * `mtllib` or a `.mtl` texture) is a plain relative path beside the model.
 *
 * A mesh file is untrusted input and this extension is read-only by design, so
 * a URI with a scheme (`http:`/`file:`/`data:`/…), an absolute path, or a `..`
 * segment that escapes the model's own directory is never fetched.
 *
 * Pure (no `vscode`, no DOM, no Node) so the host's glTF resolver and the
 * webview's `.mtl` loader share one rule.
 */
export function isSafeRelativePath(uri: string): boolean {
  if (uri.length === 0) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(uri)) return false; // any scheme, incl. data:/http:/file:
  if (uri.startsWith("/") || uri.startsWith("\\")) return false; // POSIX absolute
  if (/^[a-zA-Z]:[\\/]/.test(uri)) return false; // Windows drive-absolute
  let decoded = uri;
  try {
    decoded = decodeURIComponent(uri);
  } catch {
    return false;
  }
  return !decoded.split(/[\\/]/).some((segment) => segment === "..");
}
