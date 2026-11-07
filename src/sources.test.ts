import { test } from "node:test";
import assert from "node:assert/strict";
import { hamming, mergeMatches, sourceForUrl, verdictFor, type Match } from "./sources.js";

test("sourceForUrl recognises shop domains and country variants", () => {
  assert.equal(sourceForUrl("https://de.shein.com/item-p-123.html"), "Shein");
  assert.equal(sourceForUrl("https://shein.co.uk/x"), "Shein");
  assert.equal(sourceForUrl("https://www.temu.com/x"), "Temu");
  assert.equal(sourceForUrl("https://de.aliexpress.com/item/1.html"), "AliExpress");
});

test("sourceForUrl recognises image CDNs", () => {
  assert.equal(sourceForUrl("https://img.ltwebstatic.com/images3/a.jpg"), "Shein");
  assert.equal(sourceForUrl("https://img.kwcdn.com/product/a.jpg"), "Temu");
  assert.equal(sourceForUrl("https://ae01.alicdn.com/kf/a.jpg"), "AliExpress");
});

test("sourceForUrl ignores shop names used as someone else's subdomain", () => {
  assert.equal(sourceForUrl("https://wish.example.org/list"), null);
  assert.equal(sourceForUrl("https://temu.blogspot.com/post"), null);
  assert.equal(sourceForUrl("https://www.vinted.de/items/1"), null);
  assert.equal(sourceForUrl("https://notkwcdn.com/a.jpg"), null);
});

test("sourceForUrl returns null for invalid URLs", () => {
  assert.equal(sourceForUrl("not a url"), null);
});

test("hamming counts differing bits, including length difference", () => {
  assert.equal(hamming("0000", "0000"), 0);
  assert.equal(hamming("0101", "0000"), 2);
  assert.equal(hamming("01", "0100"), 2);
});

const m = (method: Match["method"], similarity: number | null, url = "https://x/" + method): Match => ({
  sourceName: "Shein",
  sourceUrl: url,
  similarity,
  method,
});

test("mergeMatches keeps the strongest match per source and url", () => {
  const merged = mergeMatches([m("web-page", null, "u"), m("web-full", null, "u")]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.method, "web-full");
});

test("mergeMatches orders by kind of evidence, then score", () => {
  const merged = mergeMatches([m("web-page", null), m("clip", 0.9, "a"), m("clip", 0.95, "b"), m("phash", 0.85)]);
  assert.deepEqual(
    merged.map((x) => [x.method, x.similarity]),
    [
      ["phash", 0.85],
      ["clip", 0.95],
      ["clip", 0.9],
      ["web-page", null],
    ],
  );
});

test("verdictFor needs a strong signal or two kinds of weak evidence", () => {
  assert.equal(verdictFor([]), "no_match_found");
  assert.equal(verdictFor([m("web-page", null)]), "possible_fast_fashion");
  assert.equal(verdictFor([m("web-page", null, "a"), m("web-page", null, "b")]), "possible_fast_fashion");
  assert.equal(verdictFor([m("web-page", null), m("web-partial", null)]), "likely_fast_fashion");
  assert.equal(verdictFor([m("web-full", null)]), "likely_fast_fashion");
  assert.equal(verdictFor([m("clip", 0.9)]), "likely_fast_fashion");
});
