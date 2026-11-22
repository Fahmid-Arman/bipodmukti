/* Web sign-up: Applink OTP request -> verify -> add family contacts. */

const { esc, api } = BM;
let token = null;
const $ = (id) => document.getElementById(id);
const show = (id) => ["step1", "step2", "step3"].forEach((s) => $(s).classList.toggle("hidden", s !== id));
const say = (html, cls = "err-box") => { $("msg").innerHTML = html ? `<div class="${cls}">${html}</div>` : ""; };

(async () => {
  const info = await api("/api/public/info");
  $("ussd").textContent = info.ussdCode;
  $("area").innerHTML = info.areas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}, ${esc(a.district)}</option>`).join("");
  $("consent").textContent = `By continuing you agree: ${info.consentText}`;
  $("contacts").innerHTML = [1, 2, 3].map((i) => `
    <div class="row">
      <div><label>Name ${i}</label><input name="n${i}" maxlength="24" placeholder="${i === 1 ? "e.g. Karim" : ""}"></div>
      <div><label>Mobile ${i}</label><input name="m${i}" inputmode="tel" placeholder="01XXXXXXXXX"></div>
      <div style="max-width:120px"><label>Relation</label><input name="r${i}" maxlength="16" placeholder="son"></div>
    </div>`).join("");
})();

$("step1").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const r = await api("/api/join/start", { method: "POST", body: { name: $("name").value, number: $("number").value, areaId: $("area").value } });
    token = r.token;
    $("sentTo").innerHTML = `We sent a code to <b>${esc(r.sentTo)}</b>. It is valid for 5 minutes.`;
    show("step2");
    $("otp").focus();
  } catch (err) { say(esc(err.message)); }
  btn.disabled = false;
});

$("step2").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("");
  const btn = e.target.querySelector("button");
  btn.disabled = true;
  try {
    const r = await api("/api/join/verify", { method: "POST", body: { token, otp: $("otp").value } });
    $("welcome").innerHTML = `Welcome${r.name ? `, ${esc(r.name)}` : ""}. Your number is verified and your subscription is <b>${esc(r.subscription)}</b>.`;
    show("step3");
  } catch (err) { say(esc(err.message)); }
  btn.disabled = false;
});

$("restart").addEventListener("click", () => { token = null; show("step1"); say(""); });

$("step3").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const contacts = [1, 2, 3].map((i) => ({ name: f[`n${i}`].value, number: f[`m${i}`].value, relation: f[`r${i}`].value })).filter((c) => c.number.trim());
  if (!contacts.length) { say("Add at least one number."); return; }
  try {
    const r = await api("/api/join/contacts", { method: "POST", body: { token, contacts } });
    const bad = r.results.filter((x) => !x.ok);
    say(`Saved. ${r.contacts.map((c) => `${esc(c.name || c.number)} (${esc(c.status)})`).join(", ")}.${bad.length ? ` Not added: ${bad.map((b) => esc(b.number)).join(", ")}.` : ""} You can now check in by dialling the USSD code.`, "ok-box");
  } catch (err) { say(esc(err.message)); }
});
