import test from "node:test";
import assert from "node:assert/strict";
import { resolveStaticPath } from "../src/static-path.js";

test("the bare root serves the index", () => {
  assert.equal(resolveStaticPath("/"), "/index.html");
});

test("a query string on the root still serves the index", () => {
  // The lobby's invite link is "/?room=ABC123". Mapping "/" to the index
  // before stripping the query made every one of them 404.
  assert.equal(resolveStaticPath("/?room=ABC123"), "/index.html");
  assert.equal(resolveStaticPath("/?"), "/index.html");
});

test("a file in a subdirectory resolves", () => {
  // Crests live in public/crests/. A pattern with no subdirectory branch left
  // every single crest 404ing.
  assert.equal(resolveStaticPath("/crests/Q18656.png"), "/crests/Q18656.png");
  assert.equal(resolveStaticPath("/fonts/oswald-latin.woff2"), "/fonts/oswald-latin.woff2");
});

test("a query string is stripped from any path", () => {
  assert.equal(resolveStaticPath("/style.css?v=3"), "/style.css");
  assert.equal(resolveStaticPath("/crests/Q18656.png?w=1"), "/crests/Q18656.png");
});

test("traversal is refused, including behind a query string", () => {
  for (const url of [
    "/../src/server.js",
    "/crests/../../src/server.js",
    "/..",
    "/../src/server.js?x=1",
    "/crests/..%2f..%2fsrc/server.js",
  ]) {
    assert.equal(resolveStaticPath(url), null, `${url} must be refused`);
  }
});

test("more than one subdirectory is refused", () => {
  assert.equal(resolveStaticPath("/a/b/c.png"), null);
});

test("characters outside the allowed set are refused", () => {
  for (const url of ["/a b.png", "/a;b.png", "/a\\b.png", "//etc/passwd", "/a$b"]) {
    assert.equal(resolveStaticPath(url), null, `${url} must be refused`);
  }
});

test("a non-string url is refused rather than throwing", () => {
  assert.equal(resolveStaticPath(undefined), null);
  assert.equal(resolveStaticPath(null), null);
});
