/* Shared helpers for the BipodMukti pages. No framework, no build step. */

const BM = {
  esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  },

  async api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || "GET",
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  /** Bangladesh time, HH:MM:SS */
  time(iso) {
    if (!iso) return "";
    const d = new Date(new Date(iso).getTime() + 6 * 3600 * 1000);
    return d.toISOString().slice(11, 19);
  },

  ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  },

  left(iso) {
    const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
    if (s <= 0) return "now";
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  },

  /** Subscribe to a Server-Sent Events stream; calls fn(data) and reconnects on its own. */
  stream(url, fn) {
    if (location.search.includes("snapshot")) return null; // static screenshots
    const es = new EventSource(url);
    es.onmessage = (e) => {
      try { fn(JSON.parse(e.data)); } catch { /* ignore */ }
    };
    return es;
  },

  debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  },
};
