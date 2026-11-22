/* Coordinator console: live requests, roll calls, areas, Applink activity. */

const { esc, api, time, ago, left } = BM;
let overviewData = null;
let map = null;
let markers = [];

function statusLine(i) {
  if (i.status === "resolved") return `<span class="pill ok">Closed · ${esc(i.resolution || "")}</span>`;
  if (i.status === "info") return `<span class="pill ok">Info sent</span>`;
  if (i.status === "acknowledged") return `<span class="pill ok">Handled by ${esc(i.acknowledgedBy?.name || "someone")}</span>`;
  if (i.needsCoordinator) return `<span class="pill bad">Needs coordinator</span>`;
  return `<span class="pill warn" data-until="${esc(i.nextEscalationAt || "")}">Waiting for reply · next step in <b class="cd">${i.nextEscalationAt ? left(i.nextEscalationAt) : "-"}</b></span>`;
}

function kindLabel(i) {
  if (i.kind === "help") return `HELP · ${esc(i.need || "other")}`;
  if (i.kind === "missing") return "NO REPLY";
  return esc(i.kind);
}

function renderIncidents(list) {
  const el = document.getElementById("incidents");
  if (!list.length) {
    el.innerHTML = `<div class="empty">No requests yet. Dial the USSD code or send an SMS from the <a href="/simulator">phone simulator</a>.</div>`;
    return;
  }
  el.innerHTML = list.map((i) => {
    const closed = i.status === "resolved" || i.status === "info";
    const showDetail = !closed || i.kind !== "safe";
    const events = i.events.map((e) => `<li class="${esc(e.type)}"><time>${time(e.at)}</time>${esc(e.detail)}</li>`).join("");
    const msgs = i.messages
      .filter((m) => ["alert", "volunteer-alert", "info", "ack-to-member", "ack-confirm", "ack-to-others", "resolved"].includes(m.purpose))
      .map((m) => `<span class="msg ${esc(m.status)}" title="${esc(m.purpose)} · ${esc(m.statusCode || "")} ${esc(m.statusDetail || "")} · requestId ${esc(m.requestId || "-")}">${esc(m.to)} · ${esc(m.purpose)} · <b>${esc(m.status)}</b></span>`)
      .join("");
    return `
      <article class="incident ${esc(i.kind)} ${closed ? "closed" : ""}">
        <div class="head">
          <span class="ref">${esc(i.ref)}</span>
          <span class="tag ${esc(i.kind)}">${kindLabel(i)}</span>
          <span class="who">${esc(i.member?.name || "Unknown")}</span>
          <span class="where">${esc(i.area || "")}${i.place ? ` · ${esc(i.place)}` : ""} · via ${esc(i.channel.toUpperCase())} · ${ago(i.createdAt)}</span>
          <span class="state">${statusLine(i)}</span>
        </div>
        ${showDetail ? `<ul class="timeline">${events}</ul>` : ""}
        ${msgs ? `<div class="msgs">${msgs}</div>` : ""}
        ${!closed ? `<div class="actions">
            ${i.status === "open" ? `<button class="btn small ghost" data-act="escalate" data-id="${i.id}">Alert next contact now</button>` : ""}
            <button class="btn small" data-act="resolve" data-id="${i.id}">Mark resolved</button>
          </div>` : ""}
      </article>`;
  }).join("");
}

function renderStats(o) {
  const s = o.stats;
  const items = [
    ["Members", s.members],
    ["Family contacts", s.contacts],
    ["Volunteers", s.volunteers],
    ["Open requests", s.open, s.open ? "alert" : ""],
    ["Being handled", s.acknowledged],
    ["Need coordinator", s.needsCoordinator, s.needsCoordinator ? "alert" : ""],
    ["Check-ins (24h)", s.checkIns24h],
    ["SMS delivered / failed", `${s.smsDelivered} / ${s.smsFailed}`, s.smsFailed ? "attn" : ""],
  ];
  document.getElementById("stats").innerHTML = items
    .map(([l, n, cls]) => `<div class="stat ${cls || ""}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`)
    .join("");
  document.getElementById("mode").textContent = o.mode === "simulator" ? "SIMULATOR MODE" : "LIVE APPLINK";
  const base = o.baseSize?.baseSize;
  const code = o.health?.statusCode;
  const h = document.getElementById("health");
  h.textContent = code ? `Applink ${code}${base !== undefined ? ` · base ${base}` : ""}` : "Applink: not checked";
  h.className = `pill ${code === "S1000" ? "" : code ? "bad" : ""}`;
  document.getElementById("howto").innerHTML = `USSD <code>${esc(o.ussdCode)}</code> · SMS <code>${esc(o.keyword)} SAFE</code> / <code>${esc(o.keyword)} HELP</code> to <code>${esc(o.shortcode)}</code>`;

  const sel = document.getElementById("rcArea");
  if (!sel.options.length) {
    sel.innerHTML = `<option value="">All areas</option>` + o.areas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}, ${esc(a.district)}</option>`).join("");
    sel.value = o.areas[0]?.id || "";
  }

  document.getElementById("areas").innerHTML = `<tr><th>Area</th><th>Members</th><th>Open</th><th>Safe 24h</th></tr>` +
    o.areas.map((a) => `<tr><td>${esc(a.name)}<br><small>${esc(a.district)} · ${esc(a.shelter)}</small></td><td>${a.members}</td><td>${a.open ? `<b style="color:var(--help)">${a.open}</b>` : 0}</td><td>${a.safe24h}</td></tr>`).join("");
  renderMap(o.areas);
}

function renderMap(areas) {
  if (!window.L) return;
  if (!map) {
    map = L.map("map", { scrollWheelZoom: false, attributionControl: true }).setView([23.7, 90.4], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 12, attribution: "© OpenStreetMap" }).addTo(map);
  }
  markers.forEach((m) => m.remove());
  markers = areas.filter((a) => a.lat).map((a) => {
    const color = a.open ? "#c62828" : "#0b6e4f";
    return L.circleMarker([a.lat, a.lng], { radius: 7 + Math.min(10, a.members), color, fillColor: color, fillOpacity: 0.45, weight: 2 })
      .addTo(map)
      .bindTooltip(`${a.name}: ${a.members} members, ${a.open} open`);
  });
}

function renderRollCalls(list) {
  const el = document.getElementById("rollcalls");
  if (!list.length) { el.innerHTML = `<p class="muted" style="margin-top:12px">No roll calls yet.</p>`; return; }
  el.innerHTML = list.slice(0, 3).map((r, idx) => {
    const pct = (n) => (r.total ? (100 * n) / r.total : 0);
    const targets = idx === 0 ? `<table style="margin-top:6px">${r.targets.map((t) => `<tr><td>${esc(t.name || t.number)}</td><td>${esc(t.status.replace("_", " "))}${t.ref ? ` <span class="ref">${esc(t.ref)}</span>` : ""}</td></tr>`).join("")}</table>` : "";
    return `
      <div style="margin-top:14px">
        <div class="row" style="align-items:center">
          <div><span class="ref">${esc(r.code)}</span> <b>${esc(r.title)}</b><br><small>${esc(r.area_name || "All areas")} · ${r.status === "running" ? `closes in <b data-rc="${esc(r.deadline_at)}">${left(r.deadline_at)}</b>` : "closed"}</small></div>
          ${r.status === "running" ? `<div style="flex:0"><button class="btn small ghost" data-rc-close="${r.id}">Close now</button></div>` : ""}
        </div>
        <div class="bar">
          <span class="safe" style="width:${pct(r.safe)}%"></span>
          <span class="confirmed" style="width:${pct(r.confirmed_safe)}%"></span>
          <span class="help" style="width:${pct(r.help)}%"></span>
          <span class="noresp" style="width:${pct(r.no_response)}%"></span>
        </div>
        <div class="legend">
          <span><i style="background:var(--safe)"></i>Safe ${r.safe}</span>
          <span><i style="background:#6fbf8a"></i>Family confirmed ${r.confirmed_safe}</span>
          <span><i style="background:var(--help)"></i>Help ${r.help}</span>
          <span><i style="background:var(--missing)"></i>No reply ${r.no_response}</span>
          <span><i style="background:#eef1ef"></i>Waiting ${r.pending}</span>
        </div>
        ${targets}
      </div>`;
  }).join("");
}

function renderActivity(a) {
  document.getElementById("apiFeed").innerHTML = a.applink.length
    ? a.applink.map((c) => `<div class="line"><time>${time(c.at)}</time><span class="code ${c.ok ? "ok" : "err"}">${esc(c.statusCode)}</span><span><b>${esc(c.service)}</b> · ${esc(c.summary)} · ${c.ms} ms${c.requestId ? ` · <span class="mono">${esc(c.requestId)}</span>` : ""}${c.ok ? "" : ` · ${esc(c.meaning)}`}</span></div>`).join("")
    : `<div class="empty">No Applink calls yet.</div>`;
  document.getElementById("cbFeed").innerHTML = a.callbacks.length
    ? a.callbacks.map((c) => `<div class="line"><time>${time(c.at)}</time><b>${esc(c.kind)}</b><span>${esc(c.summary)}</span></div>`).join("")
    : `<div class="empty">No callbacks yet.</div>`;
}

async function refresh() {
  try {
    const [o, inc, rc, act] = await Promise.all([
      api("/api/console/overview"),
      api("/api/console/incidents"),
      api("/api/console/rollcalls"),
      api("/api/console/activity"),
    ]);
    overviewData = o;
    renderStats(o);
    renderIncidents(inc);
    renderRollCalls(rc);
    renderActivity(act);
  } catch (err) {
    document.getElementById("incidents").innerHTML = `<div class="err-box">${esc(err.message)}</div>`;
  }
}

document.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.dataset.act === "resolve") {
      b.disabled = true;
      await api(`/api/console/incidents/${b.dataset.id}/resolve`, { method: "POST", body: { note: "closed by coordinator" } });
    } else if (b.dataset.act === "escalate") {
      b.disabled = true;
      await api(`/api/console/incidents/${b.dataset.id}/escalate`, { method: "POST", body: {} });
    } else if (b.dataset.rcClose) {
      b.disabled = true;
      await api(`/api/console/rollcalls/${b.dataset.rcClose}/close`, { method: "POST", body: {} });
    } else if (b.id === "healthBtn") {
      b.disabled = true;
      await api("/api/console/health", { method: "POST", body: {} });
      b.disabled = false;
    }
  } catch (err) {
    alert(err.message);
  }
  refresh();
});

document.getElementById("rcForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    await api("/api/console/rollcalls", {
      method: "POST",
      body: {
        areaId: document.getElementById("rcArea").value || null,
        title: document.getElementById("rcTitle").value,
        minutes: Number(document.getElementById("rcMin").value),
      },
    });
  } catch (err) {
    alert(err.message);
  }
  btn.disabled = false;
  refresh();
});

// Countdown timers tick every second without refetching.
setInterval(() => {
  document.querySelectorAll("[data-until]").forEach((el) => {
    const cd = el.querySelector(".cd");
    if (cd && el.dataset.until) cd.textContent = left(el.dataset.until);
  });
  document.querySelectorAll("[data-rc]").forEach((el) => { el.textContent = left(el.dataset.rc); });
}, 1000);

const refreshSoon = BM.debounce(refresh, 250);
BM.stream("/api/console/stream", refreshSoon);
setInterval(refresh, 15000);
refresh();
