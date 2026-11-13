// Public English page (2026-11-14, user: "link-only public release, all English, no model choice, bigger text").
// Same pipeline as app.js: mic (or file) → 16 kHz → Listener → price + close alternatives + peso confirmation.
// Fixed settings: yen rescue 0.3, alternatives ≥ 0.2 × top (max 4), tentative "?" at P(yen) ≥ 0.2.
import { Listener } from "./listener.js?v=20261114053744";

const $ = id => document.getElementById(id);
const MODEL = document.documentElement.dataset.model || new URLSearchParams(location.search).get("m") || "out_t5k_l_h";   // the published site sets data-model="model"; out_t5k_l_h = t5k_l with half-precision weights (same 120/120)
const YR = 0.3, ALTR = 0.2, TENT = 0.2;
const PESO_TOL = 0.03, PESO_WIN = 12;          // a peso amount within 12 s that is candidate × rate ± 3 % confirms that candidate

let rate = 0.44;
try { rate = +(localStorage.getItem("rate") || 0.44) || 0.44; } catch {}
$("rate").value = rate;
$("rate").onchange = () => {
  const v = +$("rate").value;
  if (!(v > 0)) { $("rate").value = rate; return; }
  rate = v; try { localStorage.setItem("rate", rate); } catch {}
  if (L) L.rate = rate;
  const r = recent.find(x => x.t === bigT);
  if (r) { const y = r.picked ?? r.confirmed ?? r.yen; $("php").textContent = php(y); } setRateLine();
};

// the arrow between yen and pesos carries the rate: ¥ … ↓ ×0.44 … ₱ (2026-11-14 user: show the "this became that" flow)
const ARROW = `<svg class="arr" viewBox="0 0 24 28" aria-hidden="true"><path d="M12 2v22M3 15l9 9 9-9" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function setRateLine() { $("rateline").innerHTML = `${ARROW}<span>× ${rate}</span>`; }
const fmtY = v => "¥" + v.toLocaleString("en-US");
const fmtP = v => "₱" + (Math.round(v * 100) / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
const php = v => fmtP(v * rate);
setRateLine();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// --- time labels: wall clock when listening live, m:ss into the file otherwise
let wall0 = 0, fileMode = false;
const clock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const stamp = t => fileMode ? clock(t) : new Date(wall0 + t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// --- status line
function status(text, live = false) { $("state").textContent = text; $("dot").classList.toggle("on", live); }
function warn(text) { $("warn").textContent = text || ""; $("warn").hidden = !text; $("state").hidden = !!text; }   // a warning takes the status text's place (same slot)

// --- "hearing…" (number being spoken, before "yen"). Shows the pesos too, so a missed "yen" still gives the seller
// the amount; tapping it keeps it as a price (2026-11-14, user: "yen が聞き取れないと悔しい")
let hearTimer = 0, hearP = null;
function onPartial(p) {
  clearTimeout(hearTimer);
  const el = $("hearing");
  const idle = () => { el.classList.remove("on"); $("hv").textContent = "…"; hearP = null; };
  if (!p) { idle(); return; }
  hearP = p;
  $("hv").innerHTML = `${fmtY(p.yen)} → <span class="hp">${php(p.yen)}</span>`;
  el.classList.add("on");
  hearTimer = setTimeout(idle, 8000);
}
setAlts([]);
$("hearing").onclick = () => {
  const p = hearP; if (!p) return;
  const li = addRow(p.t, pair(p.yen), "Kept by tap (no “yen” heard)");
  rowOf.set(p.t, li);
  recent.push({ t: p.t, yen: p.yen, all: null, li, confirmed: null, manual: true });
  showLatest(p.yen, p.words, p.t);
  const a = L && L.altsAt ? L.altsAt(p.t, p.yen) : null;             // other readings of the same stretch of sound
  if (a) { onAlts({ t: p.t, ...a, tentative: false }); setSub(li, "Kept by tap (no “yen” heard)" + (a.alts.length > 1 ? " · or " + a.alts.slice(1).map(x => `${fmtY(x.yen)} (${php(x.yen)})`).join(", ") : "")); }
};

// --- latest price card
let bigT = null, bigAt = 0;
function showLatest(y, words, t) {
  bigT = t; bigAt = Date.now();
  $("price").classList.remove("blank");
  $("yen").textContent = fmtY(y); $("php").textContent = php(y);
  note("");                                                    // no "Heard: …" line (2026-11-14, user: not needed)
  setAlts([]);
  const c = $("latest"); c.classList.remove("flash"); void c.offsetWidth; c.classList.add("flash");
  onPartial(null); tick();
}
function tick() {
  if (!bigAt) { $("ago").textContent = ""; return; }
  const s = Math.round((Date.now() - bigAt) / 1000);
  $("ago").textContent = s < 5 ? "just now" : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : "";
}
setInterval(tick, 1000);
function note(html) { $("note").innerHTML = html; }
function setAlts(list, label = "Not sure. Tap if it was:") {
  $("alts").innerHTML = list.length ? `<div class="h">${label}</div><div class="chips">${list.map(chip).join("")}</div>`
                                    : `<div class="h">Other possible prices</div><div class="none">None</div>`;
}
const chip = y => `<button class="chip num" data-yen="${y}">${fmtY(y)} · <span class="p">${php(y)}</span></button>`;
// tap an alternative: it becomes the price (sellers know what they said)
$("alts").addEventListener("click", e => {
  const b = e.target.closest(".chip"); if (!b) return;
  const y = +b.dataset.yen, r = recent.find(x => x.t === bigT);
  if (!r) return;
  const was = r.picked ?? r.yen;
  r.picked = y;
  $("yen").textContent = fmtY(y); $("php").textContent = php(y);
  note(`You picked this · first heard ${fmtY(r.yen)}`);
  const others = (r.alts || []).filter(v => v !== y);
  if (!others.includes(was)) others.unshift(was);
  setAlts(others, "Other possible prices:");
  r.li.querySelector(".v").innerHTML = pair(y);
  setSub(r.li, `Picked · first heard <span class="was">${fmtY(r.yen)}</span>`);
});

// --- history
const recent = [];                              // recent prices {t, yen, all, li, confirmed}
const rowOf = new Map();
function addRow(t, html, sub, cls) {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.innerHTML = `<span class="t num">${stamp(t)}</span><span class="v num">${html}</span>` + (sub ? `<span class="sub">${sub}</span>` : "");
  $("hist").prepend(li);
  $("hempty").hidden = true; $("clear").hidden = false;
  while ($("hist").children.length > 100) $("hist").lastElementChild.remove();
  return li;
}
const pair = y => `${fmtY(y)} <span class="p">→ ${php(y)}</span>`;
function setSub(li, html, cls = "") {
  let s = li.querySelector(".sub");
  if (!s) { s = document.createElement("span"); li.append(s); }
  s.className = "sub " + cls; s.innerHTML = html;
}
$("clear").onclick = () => {
  $("hist").innerHTML = ""; $("hempty").hidden = false; $("clear").hidden = true;
  rowOf.clear(); recent.length = 0;
  bigT = null; bigAt = 0; tick();
  $("price").classList.add("blank"); $("yen").textContent = "¥ —"; $("php").textContent = "₱ —";
  note("Say a price and it shows here."); setAlts([]);
};

// --- events from the listener
function onPrice(p) {
  if (p.kind === "peso") { onPeso({ t: p.t, php: p.yen }); return; }      // the peso amount after a price, heard as "… yen"
  if (p.kind === "repeat") {                                              // seller repeated the same price: just refresh the latest card
    const r = recent.find(x => x.yen === p.yen); if (r) { r.t2 = p.t; }
    return;
  }
  const m = recent.find(x => x.manual && x.yen === p.yen && Math.abs(p.t - x.t) < 5);
  if (m) { m.manual = false; setSub(m.li, ""); return; }                    // kept by tap, then "yen" came after all
  const li = addRow(p.t, pair(p.yen));
  rowOf.set(p.t, li);
  recent.push({ t: p.t, yen: p.yen, all: null, li, confirmed: null });
  while (recent.length > 20) recent.shift();
  if (rowOf.size > 200) rowOf.delete(rowOf.keys().next().value);
  showLatest(p.yen, p.words, p.t);
}

function onAlts(a) {
  if (a.tentative) {                                                      // a "yen"-like sound but no clear price
    const vals = a.alts.map(x => x.yen);
    addRow(a.t, vals.map(v => `${fmtY(v)}?`).join(" / "), `Maybe a price — “yen” wasn’t clear. ${vals.map(php).join(" / ")}`, "soft");
    return;
  }
  const r = recent.find(x => x.t === a.t); if (r) r.all = a.all;
  if (a.alts.length < 2) return;
  const others = a.alts.slice(1).map(x => x.yen);
  if (r) r.alts = a.alts.map(x => x.yen);
  const li = rowOf.get(a.t);
  if (li && !(r && r.confirmed)) setSub(li, "or " + others.map(v => `${fmtY(v)} (${php(v)})`).join(", "));
  if (bigT === a.t && !(r && (r.confirmed || r.picked != null))) setAlts(others);
}

function onPeso(e) {
  const fit = x => Math.abs(e.php - x * rate) <= PESO_TOL * x * rate;
  for (const r of [...recent].reverse()) {
    if (r.confirmed || e.t - (r.t2 || r.t) > PESO_WIN || e.t <= r.t) continue;
    const c = (r.all && r.all.length ? r.all.map(x => x.yen) : [r.yen]).find(fit);
    if (c == null) continue;
    r.confirmed = c;
    r.li.querySelector(".v").innerHTML = pair(c);
    setSub(r.li, `✓ You said ${fmtP(e.php)}` + (c !== r.yen ? ` · first heard <span class="was">${fmtY(r.yen)}</span>` : ""), "ok");
    if (bigT === r.t) {
      $("yen").textContent = fmtY(c); $("php").textContent = php(c); setAlts([]);
      note(`<span class="badge">✓ Matches the ${esc(fmtP(e.php))} you said</span>`);
    }
    return;
  }
  // otherwise it is the seller reading out a peso amount: nothing to show
}

function onWord() {}

// --- typing a price (calculator-style, 2026-11-14 user: "tap and type the yen like a calculator")
let kv = "", kbase = 0, kprev = null;             // the price card is the display while typing (2026-11-14 user: rewrite the price in place)
function kshow() {
  const y = +kv || 0, shown = kv ? y : kbase;
  $("yen").textContent = shown ? fmtY(shown) : "¥ —"; $("php").textContent = shown ? php(shown) : "₱ —";
  $("yen").classList.toggle("ph", !kv); $("php").classList.toggle("ph", !kv);
  $("price").classList.remove("blank");
  $("kuse").disabled = !(y > 0);
}
function kopen() {
  if (!$("keypad").hidden) return;
  kv = "";
  const r = recent.find(x => x.t === bigT);
  kbase = r ? (r.picked ?? r.confirmed ?? r.yen) : 0;
  kprev = { yen: $("yen").textContent, php: $("php").textContent, blank: $("price").classList.contains("blank") };
  document.querySelector("main").classList.add("typing");
  $("latest").classList.add("editing");
  $("keypad").hidden = $("kback").hidden = false;
  kshow();
  const top = $("latest").getBoundingClientRect().top + scrollY - 12;
  scrollTo({ top, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
function kend() {
  $("keypad").hidden = $("kback").hidden = true;
  $("latest").classList.remove("editing");
  $("yen").classList.remove("ph"); $("php").classList.remove("ph");
  document.querySelector("main").classList.remove("typing");
}
function kclose() {                                // cancel: put the card back as it was
  if ($("keypad").hidden) return;
  kend();
  if (kprev) { $("yen").textContent = kprev.yen; $("php").textContent = kprev.php; $("price").classList.toggle("blank", kprev.blank); }
}
function kkey(k) {
  if (k === "del") kv = kv.slice(0, -1);
  else if (kv.length + k.length <= 9 && !(kv === "" && k.startsWith("0"))) kv += k;
  kshow();
}
function kuse() {
  const y = +kv; if (!(y > 0)) return;
  kend();
  const r = recent.find(x => x.t === bigT);
  if (r) {                                         // a price is on screen: this corrects it
    r.picked = y;
    r.li.querySelector(".v").innerHTML = pair(y);
    setSub(r.li, y !== r.yen ? `Typed · first heard <span class="was">${fmtY(r.yen)}</span>` : "Typed");
    $("yen").textContent = fmtY(y); $("php").textContent = php(y);
    note("Typed"); setAlts([]);
    return;
  }
  if (!wall0) wall0 = Date.now();
  const t = fileMode ? 0 : (Date.now() - wall0) / 1000;
  const li = addRow(t, pair(y), "Typed");
  recent.push({ t, yen: y, all: null, li, confirmed: null, picked: y, typed: true });
  rowOf.set(t, li);
  showLatest(y, "", t);
  note("Typed");
}
$("type").onclick = kopen;
$("php").onclick = $("yen").onclick = kopen;
$("kback").onclick = $("kcancel").onclick = kclose;
$("kuse").onclick = kuse;
$("keypad").querySelector(".keys").addEventListener("click", e => { const b = e.target.closest("button"); if (b) kkey(b.dataset.k); });
document.addEventListener("keydown", e => {
  if ($("keypad").hidden) return;
  if (/^[0-9]$/.test(e.key)) kkey(e.key);
  else if (e.key === "Backspace") kkey("del");
  else if (e.key === "Enter") kuse();
  else if (e.key === "Escape") kclose();
  else return;
  e.preventDefault();
});

// --- model: load once when the page opens (on phones, loading after the tap loses the "user gesture" for audio)
globalThis.__pl = { onPrice, onAlts, onPeso, onPartial };      // for headless UI tests
let L = null, loading = null;
async function fetchProgress(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = +r.headers.get("content-length") || 0;
  if (!r.body || !total) return new Uint8Array(await r.arrayBuffer());
  // content-length can be the compressed size (GitHub Pages gzips the model), so don't size the buffer from it (2026-11-14)
  const rd = r.body.getReader(), parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); n += value.length;
    status(`Downloading the model… ${Math.min(99, Math.round(n / total * 100))}%`);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const v of parts) { out.set(v, o); o += v.length; }
  return out;
}
function load() {
  if (L) { L.reset(); return Promise.resolve(L); }
  if (!loading) loading = (async () => {
    ort.env.wasm.numThreads = 1;
    const cfg = await (await fetch(`${MODEL}/front.json`)).json();
    const buf = await fetchProgress(`${MODEL}/model.onnx`);
    status("Getting ready…");
    L = await Listener.create(ort, cfg, buf, { rate, yenr: YR, altr: ALTR, tent: TENT, onWord, onPrice, onPartial: p => { if (p) onPartial(p); }, onAlts, onPeso });   // a null (next word not a number, e.g. a misheard 'yen') doesn't clear it: it stays 8 s to be tapped
    status("Ready. Tap Start, then say a price.");
    $("start").disabled = false;
    return L;
  })().catch(e => {
    loading = null; console.error(e);
    status("Couldn’t load the model.");
    warn("Check your internet connection and reload the page.");
    $("start").disabled = false;
    throw e;
  });
  return loading;
}

// --- keep the screen on while listening
let lock = null;
async function wake(on) {
  try {
    if (on && "wakeLock" in navigator) lock = await navigator.wakeLock.request("screen");
    else if (!on && lock) { await lock.release(); lock = null; }
  } catch {}
}
document.addEventListener("visibilitychange", () => { if (running && document.visibilityState === "visible") wake(true); });

// --- microphone
let ctx = null, stream = null, running = false;
function resetSession() {
  recent.length = 0; onPartial(null);
}
async function startMic() {
  // start the mic and audio right after the tap (phones refuse if too much time passes)
  try { ctx = new AudioContext({ sampleRate: 16000 }); } catch { ctx = new AudioContext(); }
  ctx.resume();
  const gum = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
  await load();
  resetSession();
  stream = await gum;
  let src;
  try {
    await ctx.audioWorklet.addModule("worklet.js?v=20261114053744");
    src = ctx.createMediaStreamSource(stream);
  } catch {
    ctx.close();
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule("worklet.js?v=20261114053744");
    src = ctx.createMediaStreamSource(stream);
  }
  const node = new AudioWorkletNode(ctx, "tap", { processorOptions: { n: L.cfg.chunk * 160 } });
  let quiet = 0, behind = 0;
  node.port.onmessage = e => {
    const pk = e.data.peak;
    $("lv").style.width = Math.min(100, Math.max(0, (20 * Math.log10(pk + 1e-6) + 60) / 60 * 100)) + "%";
    quiet = pk < 0.003 ? quiet + 1 : 0;                       // ~10 s of near silence
    L.push(e.data.samples).then(() => {
      if (L.dropped > behind) { behind = L.dropped; warn("This phone is falling behind. Close other apps or tabs."); }
      else if (quiet > 60) warn("It’s very quiet. Speak closer to the phone.");
      else if ($("warn").textContent.startsWith("It’s very quiet")) warn("");
    });
  };
  src.connect(node);
  if (ctx.state === "suspended") await ctx.resume();
  running = true; fileMode = false; wall0 = Date.now();
  status("Listening", true); $("meter").hidden = false;
  $("start").textContent = "■ Stop"; $("start").classList.add("stop");
  wake(true);
}
function stopMic() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  if (ctx) ctx.close();
  stream = ctx = null; running = false;
  status("Stopped"); $("meter").hidden = true; warn("");
  $("start").textContent = "🎤 Start listening"; $("start").classList.remove("stop");
  wake(false);
}

let busy = false;
$("start").onclick = async () => {
  if (busy) return;
  busy = true; warn("");
  try { running ? stopMic() : await startMic(); }
  catch (e) {
    console.error(e);
    if (stream || ctx) stopMic();
    if (!L) { status("Couldn’t load the model."); warn("Check your internet connection and reload the page."); return; }
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    status("Microphone unavailable");
    warn(denied ? "Microphone access was blocked. Allow it for this site in your browser settings, then try again."
                : `The microphone couldn’t start (${e.message || e}).`);
  }
  finally { busy = false; }
};
load().catch(() => {});

// --- audio file
$("file").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  if (running) stopMic();
  try {
    await load();
    resetSession(); fileMode = true;
    status("Reading the file…", true);
    const data = await f.arrayBuffer();
    const dec = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(data);
    const off = new OfflineAudioContext(1, Math.ceil(dec.duration * 16000), 16000);
    const s = off.createBufferSource(); s.buffer = dec; s.connect(off.destination); s.start();
    const x = (await off.startRendering()).getChannelData(0);
    for (let i = 0; i < x.length; i += 2560) {
      await L.push(x.subarray(i, i + 2560));
      if (i % (2560 * 50) === 0) { status(`Reading the file… ${clock(i / 16000)} / ${clock(x.length / 16000)}`, true); await new Promise(r => setTimeout(r)); }
    }
    status(`Finished the file (${clock(x.length / 16000)})`);
  } catch (err) {
    console.error(err); status("Couldn’t read that file"); warn("Try a different audio file (mp3, m4a, wav).");
  } finally { e.target.value = ""; }
};

// test hook: ?auto=1 starts the mic right after loading (automated checks only)
if (new URLSearchParams(location.search).get("auto")) load().then(() => $("start").click());
