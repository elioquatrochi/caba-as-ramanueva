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

    const t = setTimeout(() => {
      cleanup();
      reject(new Error("JSONP timeout (no callback)"));
    }, timeoutMs);

    const sep = url.includes("?") ? "&" : "?";
    script.src = `${url}${sep}callback=${cbName}`;
    document.body.appendChild(script);
  });
}

// =========================
// CONFIG
// =========================
const API_BASE = "https://script.google.com/macros/s/AKfycbwIxzLZlq0NIJgDfGUpMddei2MknrBwgsmCCPNtNvwaHXmhnJB-nPETBIW4d5zQzPr_/exec";

// =========================
// HELPERS
// =========================
const $ = (id) => document.getElementById(id);

const today = new Date();
today.setHours(0, 0, 0, 0);

function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function onlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}

function isValidPhoneDigits(digits) {
  return /^\d{10,15}$/.test(digits);
}

// Normaliza valores de cabaña:
// acepta "2", 2, "Cabana 2", "Cabaña 2", etc. -> "2"
function cabanaId(x) {
  const s = String(x ?? "").trim();
  const m = s.match(/\d+/);
  return m ? m[0] : s;
}

// =========================
// STATE
// =========================
let allConfirmed = [];
let ranges = [];
let fpCheckin, fpCheckout, fpInline;

// =========================
// DOM
// =========================
const cabanaEl = $("cabana");
const personasEl = $("personas");
const nombreEl = $("nombre");
const telefonoEl = $("telefono");
const msgEl = $("msg");
const btnEnviar = $("btnEnviar");
const listaConfirmadas = $("listaConfirmadas");

// Forzar solo números
if (telefonoEl) {
  telefonoEl.addEventListener("input", () => {
    telefonoEl.value = onlyDigits(telefonoEl.value).slice(0, 15);
  });
}

// =========================
// CALENDAR COLORS
// =========================
function markDayClass(dayElem, date) {
  dayElem.classList.remove("day-past", "day-booked", "day-free");

  if (date < today) {
    dayElem.classList.add("day-past");
    return;
  }
  if (isBooked(date)) {
    dayElem.classList.add("day-booked");
    return;
  }
  dayElem.classList.add("day-free");
}

// =========================
// AVAILABILITY (POR NOCHE)
// Ocupado = [checkin, checkout) => checkout NO ocupa
// =========================
function isBooked(d) {
  const iso = toISO(d);
  for (const r of ranges) {
    // checkout EXCLUSIVO
    if (iso >= r.checkin && iso < r.checkout) return true;
  }
  return false;
}

function rangeCrossesBooked(inDate, outDate) {
  if (!inDate || !outDate) return false;

  const d = new Date(inDate);
  d.setHours(0, 0, 0, 0);

  const end = new Date(outDate);
  end.setHours(0, 0, 0, 0);

  // revisa noches: [in, out)
  while (d < end) {
    if (isBooked(d)) return true;
    d.setDate(d.getDate() + 1);
  }
  return false;
}

function disableFn(date) {
  if (date < today) return true;
  if (isBooked(date)) return true;
  return false;
}

function checkoutDisableFn(date) {
  if (date < today) return true;

  const inDate = fpCheckin?.selectedDates?.[0];
  if (!inDate) return true;

  // mínimo 1 noche: checkout > checkin
  if (date <= inDate) return true;

  // no permitir “saltar” sobre noches ocupadas
  if (rangeCrossesBooked(inDate, date)) return true;

  // IMPORTANTE: aunque date sea el checkout de otra reserva, NO está ocupada por noche
  // (porque ocupación es < checkout)
  return false;
}

// =========================
// FILTROS / REFRESCOS
// =========================
function applyCabanaFilter() {
  const cab = cabanaId(cabanaEl.value);

  ranges = allConfirmed
    .filter((b) => cabanaId(b.cabana) === cab)
    .map((b) => ({
      checkin: String(b.checkin).trim().slice(0, 10),
      checkout: String(b.checkout).trim().slice(0, 10),
      personas: String(b.personas ?? "").trim(),
      id: String(b.id ?? "").trim(),
      cabana: String(b.cabana ?? "").trim(),
    }));
}

function refreshList() {
  const cab = cabanaId(cabanaEl.value);

  const items = allConfirmed
    .filter((b) => cabanaId(b.cabana) === cab)
    .sort((a, b) => (a.checkin > b.checkin ? 1 : -1));

  listaConfirmadas.innerHTML = "";

  if (!items.length) {
    listaConfirmadas.innerHTML = `<li class="muted">No hay reservas confirmadas.</li>`;
    return;
  }

  for (const b of items) {
    const li = document.createElement("li");
    li.innerHTML =
      `<b>${String(b.checkin).slice(0,10)}</b> → <b>${String(b.checkout).slice(0,10)}</b>` +
      `<br><span class="muted">Personas: ${b.personas}</span>` +
      `<br><span class="muted">Checkout (salida): 09:00 — ese día queda disponible para nuevo check-in</span>`;
    listaConfirmadas.appendChild(li);
  }
}

function refreshCalendars() {
  fpCheckin?.set("disable", [disableFn]);
  fpCheckout?.set("disable", [checkoutDisableFn]);
  fpInline?.set("disable", [disableFn]);

  fpInline?.redraw();
  fpCheckin?.redraw();
  fpCheckout?.redraw();
}

async function loadAvailability() {
  try {
    const data = await jsonp(`${API_BASE}?action=availability`);
    allConfirmed = Array.isArray(data) ? data : [];

    applyCabanaFilter();
    refreshList();
    refreshCalendars();
  } catch (err) {
    console.error(err);
    msgEl.textContent =
      "No se pudo cargar disponibilidad. Revisá el deploy del WebApp (Anyone) y la URL.";
  }
}

// =========================
// CALENDARS INIT
// =========================
function initCalendars() {
  fpCheckin = flatpickr("#checkin", {
    dateFormat: "Y-m-d",
    minDate: today,
    disable: [disableFn],
    onDayCreate: (dObj, dStr, fp, dayElem) => markDayClass(dayElem, dayElem.dateObj),
    onChange: (selectedDates) => {
      const d = selectedDates[0];
      if (!d) return;

      // checkout mínimo: siguiente día
      const minOut = new Date(d);
      minOut.setDate(minOut.getDate() + 1);
      fpCheckout.set("minDate", minOut);

      const currentOut = fpCheckout.selectedDates[0];
      if (currentOut && currentOut <= d) fpCheckout.clear();
    }
  });

  fpCheckout = flatpickr("#checkout", {
    dateFormat: "Y-m-d",
    minDate: today,
    disable: [checkoutDisableFn],
    onDayCreate: (dObj, dStr, fp, dayElem) => markDayClass(dayElem, dayElem.dateObj),
  });

  fpInline = flatpickr("#calInline", {
    inline: true,
    dateFormat: "Y-m-d",
    minDate: today,
    disable: [disableFn],
    onDayCreate: (dObj, dStr, fp, dayElem) => markDayClass(dayElem, dayElem.dateObj),
  });
}

// =========================
// SUBMIT RESERVA (cliente)
// =========================
async function submitReserva(ev) {
  ev.preventDefault();
  msgEl.textContent = "";

  const payload = {
    cabana: cabanaEl.value,
    personas: personasEl.value,
    nombre: nombreEl.value.trim(),
    telefono: onlyDigits(telefonoEl.value.trim()),
    checkin: $("checkin").value,
    checkout: $("checkout").value
  };

  if (!payload.checkin || !payload.checkout) {
    msgEl.textContent = "Seleccioná check-in y check-out.";
    return;
  }
  if (!payload.nombre) {
    msgEl.textContent = "Ingresá tu nombre.";
    return;
  }
  if (!isValidPhoneDigits(payload.telefono)) {
    msgEl.textContent = "Teléfono inválido. Usá solo números (10 a 15 dígitos). Ej: 3515555555";
    return;
  }

  btnEnviar.disabled = true;
  msgEl.textContent = "Enviando solicitud…";

  try {
    const qs = new URLSearchParams({
      action: "create",
      cabana: payload.cabana,
      personas: payload.personas,
      nombre: payload.nombre,
      telefono: payload.telefono,
      checkin: payload.checkin,
      checkout: payload.checkout
    });

    const res = await jsonp(`${API_BASE}?${qs.toString()}`);

    if (!res || !res.ok) {
      msgEl.textContent = (res && res.error) ? res.error : "Error al enviar solicitud.";
      return;
    }

    msgEl.textContent = "ENVIADO. Esperá a ser contactado para confirmar disponibilidad.";
    $("formReserva").reset();
    fpCheckin.clear();
    fpCheckout.clear();

  } catch (err) {
    console.error(err);
    msgEl.textContent = "No se pudo conectar con Apps Script. Verificá URL y deploy (Anyone).";
  } finally {
    btnEnviar.disabled = false;
    await loadAvailability();
  }
}

// =========================
// BOOT
// =========================
window.addEventListener("DOMContentLoaded", async () => {
  initCalendars();
  await loadAvailability();

  cabanaEl.addEventListener("change", () => {
    applyCabanaFilter();
    refreshList();
    refreshCalendars();
  });

  $("formReserva").addEventListener("submit", submitReserva);
});
