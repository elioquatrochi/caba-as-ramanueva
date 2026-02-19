function jsonp(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const cbName = "cb_" + Math.random().toString(36).slice(2);
    const script = document.createElement("script");
    let done = false;

    const cleanup = () => {
      if (done) return;
      done = true;
      try { delete window[cbName]; } catch (e) { window[cbName] = undefined; }
      script.remove();
      clearTimeout(t);
    };

    window[cbName] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new Error("JSONP error")); };

    const t = setTimeout(() => { cleanup(); reject(new Error("JSONP timeout")); }, timeoutMs);

    const sep = url.includes("?") ? "&" : "?";
    script.src = `${url}${sep}callback=${cbName}`;
    document.body.appendChild(script);
  });
}

// =========================
// CONFIG
// =========================
const VERSION = "20260108-PRICE>=4-75K";

// TU WEBAPP
const API_BASE = "https://script.google.com/macros/s/AKfycbwIxzLZlq0NIJgDfGUpMddei2MknrBwgsmCCPNtNvwaHXmhnJB-nPETBIW4d5zQzPr_/exec";

// Mensajes
const CHECKIN_TIME = "12:00";
const CHECKOUT_TIME = "09:00";
const REMINDER_TEXT = "Llevar ropa blanca (sábanas y toallas).";
const DEPOSIT_PCT = 0.50;

// PRECIOS (REGLA: >=4 noches => 75.000)
const RATE_SHORT = 85000;          // 1..3 noches
const RATE_LONG  = 75000;          // >= 4 noches
const LONG_FROM_NIGHTS  = 4;

// =========================
// DOM
// =========================
const $ = (id) => document.getElementById(id);

const loginBox = $("loginBox");
const panel = $("panel");
const pinEl = $("pin");
const btnLogin = $("btnLogin");
const loginMsg = $("loginMsg");

const btnLogout = $("btnLogout");
const btnReset = $("btnReset");
const btnReload = $("btnReload");

const fCabana = $("fCabana");
const fEstado = $("fEstado");
const q = $("q");

const statusLine = $("statusLine");
const tbody = $("tbody");
const verLine = $("verLine");

// =========================
// STATE
// =========================
let pin = sessionStorage.getItem("owner_pin") || "";
let all = [];

// =========================
// HELPERS
// =========================
function esc(s){
  return String(s||"").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[m]));
}

function formatARS(n){
  const v = Number(n || 0);
  return "$ " + Math.round(v).toLocaleString("es-AR");
}

function chip(estado){
  const e = String(estado||"").toUpperCase();
  const cls =
    e === "CONFIRMADA" ? "confirmada" :
    e === "RECHAZADA" ? "rechazada" :
    e === "CANCELADA" ? "cancelada" : "pendiente";
  return `<span class="chip ${cls}">${esc(e || "PENDIENTE")}</span>`;
}

// Fechas robustas (UTC) para evitar problemas raros
function parseISOToUTCDate(iso){
  const [y,m,d] = String(iso||"").split("-").map(Number);
  return new Date(Date.UTC(y, (m||1)-1, d||1, 0,0,0,0));
}

function nightsBetween(checkinISO, checkoutISO){
  if (!checkinISO || !checkoutISO) return 0;
  const a = parseISOToUTCDate(checkinISO);
  const b = parseISOToUTCDate(checkoutISO);
  const ms = b.getTime() - a.getTime();
  const n = Math.round(ms / 86400000);
  return Math.max(0, n);
}

function rateForNights(n){
  return (n >= LONG_FROM_NIGHTS) ? RATE_LONG : RATE_SHORT;
}

function calcPricing(checkinISO, checkoutISO){
  const nights = nightsBetween(checkinISO, checkoutISO);
  const rate = rateForNights(nights);
  const total = nights * rate;
  const deposit = total * DEPOSIT_PCT;
  return { nights, rate, total, deposit };
}

function normalizeArPhone(tel){
  let digits = String(tel||"").replace(/\D/g,"");
  digits = digits.replace(/^0+/, "");
  if (digits.startsWith("549")) return digits;
  if (digits.startsWith("54")) return "549" + digits.slice(2);
  return "549" + digits;
}

function waUrl(tel, msg){
  const phone = normalizeArPhone(tel);
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

// API con overridePin para validar sin “logear”
async function api(action, params = {}, overridePin) {
  const qs = new URLSearchParams({ action, pin: overridePin ?? pin, ...params });
  // cache-bust: fuerza a que el navegador no use respuesta vieja
  qs.set("_v", VERSION);
  return await jsonp(`${API_BASE}?${qs.toString()}`);
}

// SIEMPRE usamos la regla local (>=4 => 75k) para que no dependa del backend
function pricingForRow(r){
  return calcPricing(r.checkin, r.checkout);
}

function buildMsg(r){
  const p = pricingForRow(r);

  const base =
    `Cabaña: ${r.cabana}\n` +
    `Personas: ${r.personas}\n` +
    `Ingreso: ${r.checkin} (desde ${CHECKIN_TIME})\n` +
    `Salida: ${r.checkout} (hasta ${CHECKOUT_TIME})\n` +
    `Noches: ${p.nights}\n` +
    `Tarifa por noche: ${formatARS(p.rate)}\n` +
    `Total: ${formatARS(p.total)}\n` +
    `Seña 50%: ${formatARS(p.deposit)}\n` +
    `Recordatorio: ${REMINDER_TEXT}\n`;

  const e = String(r.estado||"").toUpperCase();

  if (e === "CONFIRMADA"){
    return (
      `Hola ${r.nombre}, tu reserva quedó CONFIRMADA.\n\n` +
      base +
      `Para reservar se solicita seña del 50% del total.\n` +
      `Cualquier consulta, respondé este mensaje.`
    );
  }

  if (e === "RECHAZADA" || e === "CANCELADA"){
    return (
      `Hola ${r.nombre}, gracias por tu solicitud.\n` +
      `Por el momento no hay disponibilidad para ${r.checkin} a ${r.checkout} (${r.cabana}).\n` +
      `Si querés, decime otras fechas y lo revisamos.`
    );
  }

  return (
    `Hola ${r.nombre}, recibimos tu solicitud.\n\n` +
    base +
    `En breve te confirmamos disponibilidad. Para reservar se solicita seña del 50% del total.`
  );
}

function applyFilters(list){
  const cab = fCabana.value;
  const est = fEstado.value;
  const term = q.value.trim().toLowerCase();

  return list.filter(r => {
    if (cab && String(r.cabana) !== cab) return false;
    if (est && String(r.estado||"").toUpperCase() !== est) return false;

    if (term){
      const hay = [
        r.nombre, r.telefono, r.cabana, r.checkin, r.checkout, r.estado, r.createdAt
      ].join(" ").toLowerCase();
      if (!hay.includes(term)) return false;
    }
    return true;
  });
}

function render(){
  const filtered = applyFilters(all);
  statusLine.textContent = `Mostrando ${filtered.length} de ${all.length} reservas.`;

  tbody.innerHTML = filtered.map(r => {
    const p = pricingForRow(r);
    const msg = buildMsg(r);
    const wa = waUrl(r.telefono, msg);

    return `
      <tr>
        <td>${chip(r.estado)}</td>
        <td>${esc(r.cabana)}</td>
        <td>${esc(r.nombre)}</td>
        <td>${esc(r.telefono)}</td>
        <td>${esc(r.personas)}</td>
        <td>${esc(r.checkin)}</td>
        <td>${esc(r.checkout)}</td>
        <td>${esc(p.nights)}</td>
        <td><b>${esc(formatARS(p.total))}</b></td>
        <td class="muted small">${esc(r.createdAt)}</td>
        <td>
          <div class="actions">
            <a class="iconBtn wa" href="${wa}" target="_blank" rel="noopener">📱 WhatsApp</a>
            <button class="iconBtn ok" data-act="confirm" data-id="${esc(r.id)}">✅ Confirmar</button>
            <button class="iconBtn no" data-act="reject" data-id="${esc(r.id)}">❌ Rechazar</button>
            <button class="iconBtn del" data-act="delete" data-id="${esc(r.id)}">🗑 Eliminar</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

// Carga validando respuesta: si no es array => error (PIN inválido o deploy mal)
async function loadOrThrow(){
  statusLine.textContent = "Cargando…";
  const res = await api("owner_list");
  if (!Array.isArray(res)) throw new Error(res?.error || "Respuesta inválida");
  all = res;
  render();
}

function showPanel(){
  loginBox.classList.add("hidden");
  panel.classList.remove("hidden");
}

function showLogin(){
  panel.classList.add("hidden");
  loginBox.classList.remove("hidden");
}

function clearAuth(){
  sessionStorage.removeItem("owner_pin");
  pin = "";
  all = [];
}

// Login fuerte: si PIN inválido => NO entra, NO guarda, se queda en login
async function loginWithPin(candidatePin){
  loginMsg.textContent = "";
  statusLine.textContent = "";

  const p = String(candidatePin || "").trim();
  if (!p) { loginMsg.textContent = "Ingresá PIN."; return; }

  try{
    // validar PIN REAL antes de entrar
    const test = await api("owner_list", {}, p);
    if (!Array.isArray(test)) throw new Error(test?.error || "PIN inválido");

    pin = p;
    sessionStorage.setItem("owner_pin", pin);
    showPanel();
    all = test;
    render();
  } catch (err) {
    console.error(err);
    clearAuth();
    showLogin();
    loginMsg.textContent = "PIN inválido. No se puede ingresar.";
  }
}

// =========================
// EVENTS
// =========================
btnLogin.addEventListener("click", async () => {
  await loginWithPin(pinEl.value);
});

btnLogout.addEventListener("click", () => {
  clearAuth();
  pinEl.value = "";
  showLogin();
});

btnReload.addEventListener("click", async () => {
  try{ await loadOrThrow(); }
  catch(e){
    console.error(e);
    clearAuth();
    showLogin();
    loginMsg.textContent = "Sesión inválida. Volvé a ingresar el PIN.";
  }
});

[fCabana, fEstado, q].forEach(el => el.addEventListener("input", render));

tbody.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;

  const act = btn.dataset.act;
  const id = btn.dataset.id;

  try{
    if (act === "delete") {
      if (!confirm("¿Eliminar esta reserva?")) return;
      const r = await api("owner_delete", { id });
      if (!r.ok) { alert(r.error || "No se pudo eliminar"); return; }
      await loadOrThrow();
      return;
    }

    if (act === "confirm" || act === "reject") {
      const label = act === "confirm" ? "CONFIRMAR" : "RECHAZAR";
      if (!confirm(`¿${label} esta reserva?`)) return;

      const r = await api("owner_decide", { id, decision: act });
      if (!r.ok) { alert(r.error || "No se pudo actualizar"); }
      await loadOrThrow();
    }
  } catch (e) {
    console.error(e);
    clearAuth();
    showLogin();
    loginMsg.textContent = "Sesión inválida. Volvé a ingresar el PIN.";
  }
});

btnReset.addEventListener("click", async () => {
  if (!confirm("Esto BORRA TODO y deja la hoja en cero. ¿Confirmás?")) return;
  try{
    const r = await api("owner_reset");
    if (!r.ok) { alert(r.error || "No se pudo resetear"); return; }
    await loadOrThrow();
  } catch(e) {
    console.error(e);
    clearAuth();
    showLogin();
    loginMsg.textContent = "Sesión inválida. Volvé a ingresar el PIN.";
  }
});

// Auto-login SOLO si el PIN guardado es válido
window.addEventListener("DOMContentLoaded", async () => {
  if (verLine) {
    verLine.textContent = `owner.js v${VERSION} · regla: >=${LONG_FROM_NIGHTS} noches => ${formatARS(RATE_LONG)} · API: ${API_BASE.slice(0, 45)}…`;
  }

  if (!pin) { showLogin(); return; }

  try{
    const test = await api("owner_list", {}, pin);
    if (!Array.isArray(test)) throw new Error(test?.error || "PIN inválido");
    showPanel();
    all = test;
    render();
  } catch(e){
    console.error(e);
    clearAuth();
    showLogin();
    loginMsg.textContent = "PIN inválido o vencido. Ingresá nuevamente.";
  }
});
