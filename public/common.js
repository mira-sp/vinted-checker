// Shared helpers for the pages.

export const SHOPS = ["Shein", "Temu", "AliExpress", "Zaful", "Cider", "DHgate", "Wish"];

export const METHOD = {
  clip: "Visually similar saved reference",
  phash: "Near-identical saved image",
  "web-full": "Exact image found online",
  "web-partial": "Partially matching image online",
  "web-page": "Image appears on this page",
};

/** Escapes text for use inside HTML. */
export function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

/** Returns the URL if it is http(s), otherwise null. */
export function safeUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {}
  return null;
}

/** Short label and CSS class for a verdict. */
export function verdictBadge(verdict) {
  if (verdict === "likely_fast_fashion") return { text: "Likely fast fashion", cls: "flag" };
  if (verdict === "possible_fast_fashion") return { text: "Possibly fast fashion", cls: "maybe" };
  if (verdict === "no_match_found") return { text: "No match", cls: "ok" };
  return { text: "Not checked", cls: "none" };
}

export function badgeHtml(verdict) {
  const b = verdictBadge(verdict);
  return '<span class="badge ' + b.cls + '">' + esc(b.text) + "</span>";
}

/** fetch() that returns parsed JSON and throws with the server's error message. */
export async function api(url, options = {}) {
  const init = { ...options };
  if (init.json !== undefined) {
    init.method ??= "POST";
    init.headers = { "Content-Type": "application/json", ...init.headers };
    init.body = JSON.stringify(init.json);
    delete init.json;
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed (HTTP " + res.status + ").");
  return data;
}

/** SQLite timestamps are UTC without a zone; show them in local time. */
export function formatDate(sqlite) {
  const d = new Date(String(sqlite).replace(" ", "T") + "Z");
  return isNaN(d) ? "" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Banner when references are missing embeddings for the active model,
 * e.g. right after switching EMBEDDING_MODEL. Returns "" when all is fine.
 */
export async function embeddingWarning() {
  try {
    const h = await api("/health");
    const missing = h.references - (h.embedded?.[h.model] ?? 0);
    if (missing <= 0) return "";
    return (
      '<div class="banner maybe">' +
      missing +
      " of " +
      h.references +
      " references have no " +
      esc(h.model) +
      " embedding yet, so the visual check can't use them. Run <code>npm run reembed</code>.</div>"
    );
  } catch {
    return "";
  }
}
