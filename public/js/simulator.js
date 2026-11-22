/* Virtual basic phones driving BipodMukti through simulated Applink callbacks. */

const { esc, api, time, left } = BM;
const phones = new Map();
let shown = [];
let info = { ussdCode: "*213*55#", keyword: "BM" };

const enc = (a) => encodeURIComponent(a);

/** Reference of the latest alert this phone received (alerts only, not receipts). */
function lastRef(p) {
  for (let i = p.sms.length - 1; i >= 0; i--) {
    const t = p.sms[i].text;
    if (p.sms[i].direction !== "in" || !/ALERT|URGENT|No reply from/.test(t)) continue;
    const m = /\b([HM]\d+)\b/.exec(t);
    if (m) return m[1];
  }
  return null;
}

function screenHtml(p) {
  if (!p.online) return `<div class="offmsg">Phone switched off</div>`;
  if (p.ussd) {
    return `<div class="ussd"><div class="title">USSD ${p.ussd.open ? "" : "· session ended"}</div>${esc(p.ussd.waiting ? "…" : p.ussd.screen)}</div>`;
  }
  if (!p.sms.length) return `<div class="offmsg">No messages</div>`;
  return p.sms.slice().reverse().map((m) =>
    `<div class="sms ${m.direction}"><div class="meta">${m.direction === "in" ? `From ${esc(m.peer)}` : `To ${esc(m.peer)}`} · ${time(m.at)}</div>${esc(m.text)}</div>`).join("");
}

function keysHtml(p) {
  const kw = info.keyword;
  if (p.ussd) {
    if (!p.ussd.open) return `<button data-a="ussd-close">OK</button>`;
    return ["1", "2", "3", "4", "0"].map((k) => `<button data-a="ussd-key" data-k="${k}">${k}</button>`).join("") + `<button class="red" data-a="ussd-close">Cancel</button>`;
  }
  const ref = lastRef(p);
  const quick = [
    `<button class="primary" data-a="dial">Dial ${esc(info.ussdCode)}</button>`,
    `<button data-a="sms" data-t="${kw} SAFE">${kw} SAFE</button>`,
    `<button data-a="sms" data-t="${kw} HELP rescue">${kw} HELP</button>`,
  ];
  if (ref) {
    quick.push(`<button data-a="sms" data-t="${kw} OK ${ref}">${kw} OK ${ref}</button>`);
    if (ref.startsWith("M")) quick.push(`<button data-a="sms" data-t="${kw} SAFE ${ref}">${kw} SAFE ${ref}</button>`);
  }
  if (p.sms.some((m) => /Reply \w+ YES to accept/.test(m.text))) quick.push(`<button data-a="sms" data-t="${kw} YES">${kw} YES</button>`);
  return quick.join("");
}

function phoneHtml(p) {
  return `
    <div class="phone ${p.online ? "" : "off"}" data-addr="${esc(p.address)}">
      <div class="ph-head">
        <b>${esc(p.name || p.local)}</b><span>${esc(p.local)}</span>
        <span class="role">${esc(p.role)}</span>
      </div>
      <div class="lcd">${screenHtml(p)}</div>
      <form class="ph-input">
        <input name="t" autocomplete="off" placeholder="${p.ussd?.open ? "Type reply" : "SMS text or *code#"}" ${p.online ? "" : "disabled"}>
        <button class="btn small" ${p.online ? "" : "disabled"}>${p.ussd?.open ? "Reply" : "Send"}</button>
      </form>
      <div class="ph-keys">
        ${p.online ? keysHtml(p) : ""}
        <button data-a="power">${p.online ? "Switch off" : "Switch on"}</button>
        ${p.online && !p.ussd ? `<button data-a="clear">Clear</button>` : ""}
      </div>
    </div>`;
}

function render() {
  const el = document.getElementById("phones");
  const active = document.activeElement;
  const focused = active?.closest?.(".phone")?.dataset.addr;
  const draft = focused ? active.value : null;
  el.innerHTML = shown.map((a) => phones.get(a)).filter(Boolean).map(phoneHtml).join("");
  if (focused) {
    const input = el.querySelector(`.phone[data-addr="${CSS.escape(focused)}"] input`);
    if (input) { input.value = draft || ""; input.focus(); }
  }
  const pick = document.getElementById("pick");
  const all = [...phones.values()];
  pick.innerHTML = `<option value="">Choose…</option>` + all.map((p) => `<option value="${esc(p.address)}">${esc(p.name || p.local)} · ${esc(p.local)} (${esc(p.role)})</option>`).join("");
}

async function act(addr, action, extra = {}) {
  const base = `/sim/phones/${enc(addr)}`;
  let p;
  if (action === "power") p = await api(`${base}/power`, { method: "POST", body: { online: !phones.get(addr).online } });
  else if (action === "dial") p = await api(`${base}/ussd`, { method: "POST", body: { dial: true, text: extra.text || info.ussdCode } });
  else if (action === "ussd-key") p = await api(`${base}/ussd`, { method: "POST", body: { text: extra.text } });
  else if (action === "ussd-close") p = await api(`${base}/ussd/close`, { method: "POST", body: {} });
  else if (action === "sms") p = await api(`${base}/sms`, { method: "POST", body: { text: extra.text } });
  else if (action === "clear") p = await api(`${base}/clear`, { method: "POST", body: {} });
  if (p) { phones.set(p.address, p); render(); }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest(".ph-keys button");
  if (!b) return;
  const addr = b.closest(".phone").dataset.addr;
  act(addr, b.dataset.a, { text: b.dataset.t || b.dataset.k }).catch((err) => alert(err.message));
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest(".ph-input");
  if (!form) return;
  e.preventDefault();
  const addr = form.closest(".phone").dataset.addr;
  const text = form.t.value.trim();
  if (!text) return;
  form.t.value = "";
  const p = phones.get(addr);
  if (p.ussd?.open) act(addr, "ussd-key", { text });
  else if (/^\*[\d*]+#$/.test(text)) act(addr, "dial", { text });
  else act(addr, "sms", { text });
});

document.getElementById("pick").addEventListener("change", (e) => {
  const a = e.target.value;
  if (a && !shown.includes(a)) { shown.unshift(a); shown = shown.slice(0, 6); render(); }
});

document.getElementById("addBtn").addEventListener("click", async () => {
  try {
    const p = await api("/sim/phones", { method: "POST", body: { number: document.getElementById("newNum").value } });
    phones.set(p.address, p);
    if (!shown.includes(p.address)) shown.unshift(p.address);
    document.getElementById("newNum").value = "";
    render();
  } catch (err) { alert(err.message); }
});

async function renderLatest() {
  try {
    const list = await api("/api/console/incidents");
    const i = list.find((x) => x.kind !== "safe" || x.status !== "info") || list[0];
    const el = document.getElementById("latest");
    if (!i) { el.innerHTML = `<div class="empty">No requests yet.</div>`; return; }
    const state = i.status === "acknowledged" ? `<span class="pill ok">Handled by ${esc(i.acknowledgedBy?.name || "")}</span>`
      : i.status === "resolved" ? `<span class="pill ok">Closed</span>`
      : i.status === "info" ? `<span class="pill ok">Info</span>`
      : i.needsCoordinator ? `<span class="pill bad">Needs coordinator</span>`
      : `<span class="pill warn">Next step in <b data-until="${esc(i.nextEscalationAt || "")}">${i.nextEscalationAt ? left(i.nextEscalationAt) : "-"}</b></span>`;
    el.innerHTML = `
      <div class="incident ${esc(i.kind)}">
        <div class="head"><span class="ref">${esc(i.ref)}</span><span class="tag ${esc(i.kind)}">${esc(i.kind)}${i.need ? ` · ${esc(i.need)}` : ""}</span><span class="who">${esc(i.member?.name || "")}</span></div>
        <div class="where" style="margin-top:4px">${esc(i.place)} · via ${esc(i.channel.toUpperCase())}</div>
        <div style="margin-top:6px">${state}</div>
        <ul class="timeline">${i.events.map((e) => `<li class="${esc(e.type)}"><time>${time(e.at)}</time>${esc(e.detail)}</li>`).join("")}</ul>
        <div class="msgs">${i.messages.filter((m) => m.purpose.includes("alert")).map((m) => `<span class="msg ${esc(m.status)}">${esc(m.to)} · <b>${esc(m.status)}</b></span>`).join("")}</div>
      </div>`;
  } catch { /* console may be password-protected */ }
}

setInterval(() => document.querySelectorAll("#latest [data-until]").forEach((el) => { el.textContent = left(el.dataset.until); }), 1000);

async function init() {
  try {
    info = await api("/api/public/info");
    document.getElementById("mode").textContent = info.mode === "simulator" ? "SIMULATOR" : "LIVE APPLINK";
    const list = await api("/sim/phones");
    list.forEach((p) => phones.set(p.address, p));
    const byName = (n) => list.find((p) => p.name.startsWith(n))?.address;
    shown = [byName("Rahima"), byName("Karim"), byName("Rina"), byName("Jamal")].filter(Boolean);
    if (!shown.length) shown = list.slice(0, 4).map((p) => p.address);
    render();
    BM.stream("/sim/stream", (p) => { phones.set(p.address, p); render(); });
    BM.stream("/api/console/stream", BM.debounce(renderLatest, 300));
    renderLatest();
  } catch {
    document.getElementById("disabled").classList.remove("hidden");
  }
}
init();
