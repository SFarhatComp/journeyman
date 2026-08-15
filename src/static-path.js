/**
 * Map a request URL to a file under public/, or null to refuse it.
 *
 * Its own module rather than a helper inside server.js, because importing
 * server.js runs it: it loads a 5MB dataset and binds a port. A guard that
 * cannot be tested without starting a server does not get tested.
 *
 * It has now been wrong twice — once rejecting subdirectories, so no crest
 * loaded, and once mapping "/" to the index before stripping the query, so
 * every "/?room=CODE" invite link 404'd. Small enough to look obviously
 * correct, and it was not.
 */
export function resolveStaticPath(url) {
  if (typeof url !== "string") return null;
  const path = url.split("?")[0];
  if (path === "/") return "/index.html";
  // One optional subdirectory, for /crests/Q18656.png. The explicit ".." check
  // is what actually stops traversal: "." is a legal filename character, so the
  // character class alone matches "/../etc" happily.
  if (!/^\/[\w.-]+(\/[\w.-]+)?$/.test(path) || path.includes("..")) return null;
  return path;
}
