// =========================
// JSONP
// =========================
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
// CONFIG (PRECIOS / POLÍTICAS)
// =========================
const API_BASE = "https://script.google.com/macros/s/AKfycbwIxzLZlq0NIJgDfGUpMddei2MknrBwgsmCCPNtNvwaHXmhnJB-nPETBIW4d5zQzPr_/exec";

// < 3 noches => 85.000 / noche
// >= 3 noches => 75.000 / noche
const RATE_SHORT = 85000;
const RATE_LONG  = 75000;
const LONG_FROM_NIGHTS = 3;

const DEPOSIT_PCT = 0.50;
const REMINDER_TEXT = "Recordatorio: Llevar ropa blanca.";

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
function isoToDate0(iso) {
  const [y, m, d] = String(iso).split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}
function onlyDigits(s) {
  return String(s || "").replace(/\D/g, "");
}
function isValidPhoneDigits(digits) {
  return /^\d{10,15}$/.test(digits);
}
function money(n) {
  const v = Math.round(Number(n || 0));
  return v.toLocaleString("es-AR");
}
function diffNights(checkinISO, checkoutISO) {
  const a = isoToDate0(checkinISO);
  const b = isoToDate0(checkoutISO);
  return Math.max(0, Math.round((b - a) / 86400000)); // días = noches
}
function rateForNights(n) {
  return (n >= LONG_FROM_NIGHTS) ? RATE_LONG : RATE_SHORT;
}

// Normaliza cabaña: "Cabana 3" / "Cabaña 3" / 3 -> "3"
function cabanaId(x) {
  const s = String(x ?? "").trim();
  const m = s.match(/\d+/);
  return m ? m[0] : s;
}

// =========================
// STATE
// =========================
let allConfirmed = []; // confirmadas global
let ranges = [];       // confirmadas filtradas por cabaña

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

// Precio UI
const priceBox = $("priceBox");
const pNoches = $("pNoches");
const pRate = $("pRate");
const pTotal = $("pTotal");
const pDeposit = $("pDeposit");
const pHint = $("pHint");

telefonoEl?.addEventListener("input", () => {
  telefonoEl.value = onlyDigits(telefonoEl.value).slice(0, 15);
});

// =========================
// PINTADO CALENDARIO (por noches)
// =========================
// Ocupado si iso está en [checkin, checkout) => checkout NO ocupa
function isBooked(d) {
  const iso = toISO(d);
  for (const r of ranges) {
    if (iso >= r.checkin && iso < r.checkout) return true;
  }
  return false;
}

function markDayClass(dayElem, date) {
  dayElem.classList.remove("day-past", "day-booked", "day-free");

  if (date < today) return dayElem.classList.add("day-past");
  if (isBooked(date)) return dayElem.classList.add("day-booked");
  dayElem.classList.add("day-free");
}

function disableCheckin(date) {
  if (date < today) return true;
  // checkin no puede caer en una noche ocupada
  if (isBooked(date)) return true;
  return false;
}

// Para checkout: permitir que sea un día “ocupado” por otra reserva (ej checkout = otro checkin),
// siempre que NO cruce noches ocupadas en el medio.
function rangeCrossesBooked(inDate, outDate) {
  if (!inDate || !outDate) return false;

  const d = new Date(inDate); d.setHours(0,0,0,0);
  const end = new Date(outDate); end.setHours(0,0,0,0);

  // noches: [inDate, outDate) => NO incluye el día outDate
  while (d < end) {
    if (isBooked(d)) return true;
    d.setDate(d.getDate() + 1);
  }
  return false;
}

function disableCheckout(date) {
  if (date < today) return true;

  const inDate = fpCheckin?.selectedDates?.[0];
  if (!inDate) return false;

  // checkout debe ser > checkin (mínimo 1 noche)
  if (date <= inDate) return true;

  // bloquea si hay noches ocupadas entre medio
  if (rangeCrossesBooked(inDate, date)) return true;

  return false;
}

// =========================
// LISTA + REFRESCOS
// =========================
function applyCabanaFilter() {
  if (!cabanaEl) return; // ✅ evita errores en portada
  const cab = cabanaId(cabanaEl.value);
  ranges = allConfirmed
    .filter((b) => cabanaId(b.cabana) === cab)
    .map((b) => ({
      checkin: String(b.checkin).trim(),
      checkout: String(b.checkout).trim(),
      personas: String(b.personas ?? "").trim(),
      cabana: b.cabana
    }));
}

function refreshList() {
  if (!cabanaEl || !listaConfirmadas) return; // ✅
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
    li.innerHTML = `<b>${b.checkin}</b> → <b>${b.checkout}</b><br><span class="muted">Personas: ${b.personas}</span>`;
    listaConfirmadas.appendChild(li);
  }
}

function refreshCalendars() {
  // ✅ si no existe flatpickr o instancias, no rompe
  fpCheckin?.set?.("disable", [disableCheckin]);
  fpCheckout?.set?.("disable", [disableCheckout]);
  fpInline?.set?.("disable", [disableCheckin]);

  fpInline?.redraw?.();
  fpCheckin?.redraw?.();
  fpCheckout?.redraw?.();
}

// =========================
// PRECIO UI
// =========================
function updatePriceBox() {
  // ✅ Si no existe la UI, no hace nada
  if (!priceBox || !pNoches || !pRate || !pTotal || !pDeposit || !pHint) return;

  const inISO = $("checkin")?.value;
  const outISO = $("checkout")?.value;

  if (!inISO || !outISO) {
    priceBox.hidden = true;
    return;
  }

  const nights = diffNights(inISO, outISO);
  if (nights <= 0) {
    priceBox.hidden = true;
    return;
  }

  const rate = rateForNights(nights);
  const total = nights * rate;
  const deposit = total * DEPOSIT_PCT;

  pNoches.textContent = String(nights);
  pRate.textContent = `$${money(rate)}`;
  pTotal.textContent = `$${money(total)}`;
  pDeposit.textContent = `$${money(deposit)}`;
  pHint.textContent = `${REMINDER_TEXT} Para reservar: seña del 50% del total.`;

  priceBox.hidden = false;
}

// =========================
// LOAD AVAILABILITY
// =========================
async function loadAvailability() {
  try {
    const data = await jsonp(`${API_BASE}?action=availability`);
    allConfirmed = Array.isArray(data) ? data : [];

    applyCabanaFilter();
    refreshList();
    refreshCalendars();
  } catch (err) {
    console.error(err);
    if (msgEl) msgEl.textContent = "No se pudo cargar disponibilidad (Apps Script). Revisá URL y Deploy (Anyone).";
  }
}

// =========================
// CALENDARS INIT
// =========================
function initCalendars() {
  // ✅ Si flatpickr no existe, no rompe (portada)
  if (typeof flatpickr === "undefined") return;
  if (!$("checkin") || !$("checkout") || !$("calInline")) return;

  fpCheckin = flatpickr("#checkin", {
    dateFormat: "Y-m-d",
    minDate: today,
    disable: [disableCheckin],
    onDayCreate: (_, __, ___, dayElem) => markDayClass(dayElem, dayElem.dateObj),
    onChange: (selectedDates) => {
      const d = selectedDates[0];
      if (!d) return;

      // checkout mínimo = checkin + 1 día (1 noche)
      const minOut = new Date(d);
      minOut.setDate(minOut.getDate() + 1);
      fpCheckout.set("minDate", minOut);

      const currentOut = fpCheckout.selectedDates[0];
      if (currentOut && currentOut <= d) fpCheckout.clear();

      updatePriceBox();
    }
  });

  fpCheckout = flatpickr("#checkout", {
    dateFormat: "Y-m-d",
    minDate: today,
    disable: [disableCheckout],
    onDayCreate: (_, __, ___, dayElem) => markDayClass(dayElem, dayElem.dateObj),
    onChange: () => updatePriceBox()
  });

  fpInline = flatpickr("#calInline", {
    inline: true,
    dateFormat: "Y-m-d",
    minDate: today,
    disable: [disableCheckin],
    onDayCreate: (_, __, ___, dayElem) => markDayClass(dayElem, dayElem.dateObj),
  });
}

// =========================
// SUBMIT RESERVA (cliente)
// =========================
async function submitReserva(ev) {
  ev.preventDefault();
  if (msgEl) msgEl.textContent = "";

  const payload = {
    cabana: cabanaEl?.value,
    personas: personasEl?.value,
    nombre: (nombreEl?.value || "").trim(),
    telefono: onlyDigits((telefonoEl?.value || "").trim()),
    checkin: $("checkin")?.value,
    checkout: $("checkout")?.value
  };

  if (!payload.checkin || !payload.checkout) return msgEl && (msgEl.textContent = "Seleccioná check-in y check-out.");
  if (!payload.nombre) return msgEl && (msgEl.textContent = "Ingresá tu nombre.");
  if (!isValidPhoneDigits(payload.telefono)) return msgEl && (msgEl.textContent = "Teléfono inválido. Usá 10 a 15 dígitos. Ej: 3515555555");

  // Validación por noches: checkout tiene que ser >= checkin + 1
  const nights = diffNights(payload.checkin, payload.checkout);
  if (nights < 1) return msgEl && (msgEl.textContent = "La reserva debe ser mínimo de 1 noche.");

  if (btnEnviar) btnEnviar.disabled = true;
  if (msgEl) msgEl.textContent = "Enviando solicitud…";

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
      if (msgEl) msgEl.textContent = (res && res.error) ? res.error : "Error al enviar solicitud.";
      return;
    }

    if (msgEl) msgEl.textContent = "ENVIADO. Te vamos a contactar para confirmar disponibilidad y forma de pago.";
    $("formReserva")?.reset?.();
    fpCheckin?.clear?.();
    fpCheckout?.clear?.();
    updatePriceBox();

  } catch (err) {
    console.error(err);
    if (msgEl) msgEl.textContent = "No se pudo conectar con Apps Script. Verificá URL y Deploy (Anyone).";
  } finally {
    if (btnEnviar) btnEnviar.disabled = false;
    await loadAvailability();
  }
}

// =========================
// BOOT
// =========================
window.addEventListener("DOMContentLoaded", async () => {
  // ✅ Detecta si estás en la página de reservas
  const isReservaPage = !!$("formReserva");

  if (isReservaPage) {
    initCalendars();
    await loadAvailability();

    cabanaEl?.addEventListener?.("change", () => {
      applyCabanaFilter();
      refreshList();
      refreshCalendars();
    });

    $("formReserva")?.addEventListener?.("submit", submitReserva);
  }
});


// =========================
// LIGHTBOX (galerías por cabaña)
// =========================

// 1) Definí acá las fotos de cada cabaña
//    IMPORTANTE: usá la extensión real (.jpeg o .jpg)
const GALLERIES = {
  c1: [
    "img/foto1.jpeg",
    "img/foto2.jpeg",
    "img/foto3.jpeg",
    "img/foto4.jpeg",
    "img/foto5.jpeg",
    "img/foto6.jpeg",
    "img/foto7.jpeg",
  ],
  c2: [
    "img/foto8.jpeg",
    "img/foto9.jpeg",
    "img/foto10.jpeg",
    "img/foto11.jpeg",
    "img/foto12.jpeg",
    "img/foto13.jpeg",
    "img/foto14.jpeg",
    "img/foto15.jpeg",
    "img/foto16.jpeg",
    "img/foto17.jpeg",
  ],
  c3: [
    "img/foto18.jpeg",
    "img/foto19.jpeg",
    "img/foto20.jpeg",
    "img/foto21.jpeg",
    "img/foto22.jpeg",
    "img/foto23.jpeg",
    "img/foto24.jpeg",
    "img/foto25.jpeg",
    "img/foto26.jpeg",
  ],
  c4: [
    "img/foto27.jpeg",
    "img/foto28.jpeg",
    "img/foto29.jpeg",
    "img/foto30.jpeg",
    "img/foto31.jpeg",
    "img/foto32.jpeg",
    "img/foto33.jpeg",
    "img/foto34.jpeg",
  ],
};

const lightbox = document.getElementById("lightbox");
const closeLightboxBtn = document.getElementById("closeLightboxBtn");
const swiperWrapper = document.getElementById("lightbox-swiper-wrapper");

let lightboxSwiper = null;

function buildSlides(images) {
  if (!swiperWrapper) return; // ✅ evita error si no existe
  swiperWrapper.innerHTML = "";
  images.forEach((src) => {
    const slide = document.createElement("div");
    slide.className = "swiper-slide";
    slide.innerHTML = `<img src="${src}" alt="Foto cabaña" loading="eager" decoding="async">`;
    swiperWrapper.appendChild(slide);
  });
}

function openLightbox(galleryId) {
  // ✅ si Swiper no está cargado o no existe el modal, no rompe
  if (typeof Swiper === "undefined") return;
  if (!lightbox || !swiperWrapper) return;

  const images = GALLERIES[galleryId] || [];
  if (!images.length) {
    console.warn(`No hay imágenes configuradas para ${galleryId}`);
    return;
  }

  buildSlides(images);

  // Abrir modal
  lightbox.classList.add("is-open");
  lightbox.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  // (Re)iniciar swiper
  if (lightboxSwiper) {
    lightboxSwiper.destroy(true, true);
    lightboxSwiper = null;
  }

  lightboxSwiper = new Swiper("#lightboxSwiper", {
    loop: true,
    spaceBetween: 12,
    pagination: { el: "#lightboxSwiper .swiper-pagination", clickable: true },
    navigation: {
      nextEl: "#lightboxSwiper .swiper-button-next",
      prevEl: "#lightboxSwiper .swiper-button-prev",
    },
    keyboard: { enabled: true },
  });
}

function closeLightbox() {
  if (!lightbox) return;
  lightbox.classList.remove("is-open");
  lightbox.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";

  if (lightboxSwiper) {
    lightboxSwiper.destroy(true, true);
    lightboxSwiper = null;
  }
  if (swiperWrapper) swiperWrapper.innerHTML = "";
}

// Click en botones "Ver fotos"
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-open-lightbox]");
  if (!btn) return;

  const galleryId = btn.getAttribute("data-open-lightbox");
  openLightbox(galleryId);
});

// Cerrar por botón
closeLightboxBtn?.addEventListener("click", closeLightbox);

// Cerrar clickeando fondo oscuro (afuera del swiper)
lightbox?.addEventListener("click", (e) => {
  if (e.target === lightbox) closeLightbox();
});

// Cerrar con ESC
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && lightbox?.classList.contains("is-open")) {
    closeLightbox();
  }
});


// =========================
// ✅ PORTADA: HERO SWIPER 3s + sólo corre cuando está visible
// =========================
(function initHeroSwiper(){
  const heroEl = document.getElementById("heroSwiper");
  const heroSection = document.getElementById("hero");
  if (!heroEl || typeof Swiper === "undefined") return;

  const hero = new Swiper(heroEl, {
    loop: true,
    speed: 650,
    effect: "fade",
    fadeEffect: { crossFade: true },
    autoplay: { delay: 3000, disableOnInteraction: false, pauseOnMouseEnter: true },
    pagination: { el: ".hero-pagination", clickable: true },
    navigation: { nextEl: ".hero-next", prevEl: ".hero-prev" },
  });

  if (!heroSection || !("IntersectionObserver" in window)) return;

  let running = true;
  const io = new IntersectionObserver((entries) => {
    const e = entries[0];
    const visible = e.isIntersecting && e.intersectionRatio >= 0.35;
    if (visible && !running) { hero.autoplay?.start(); running = true; }
    if (!visible && running) { hero.autoplay?.stop(); running = false; }
  }, { threshold: [0, .2, .35, .5, .8, 1] });

  io.observe(heroSection);
})();


// =========================
// ✅ PORTADA: MENU MOBILE + HEADER SCROLL
// =========================
(function navMobile(){
  const header = document.getElementById("header");
  const btn = document.getElementById("mobileNavToggle");
  const menu = document.getElementById("mobileMenu");
  if (!btn || !menu) return;

  const setOpen = (open) => {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    menu.classList.toggle("is-open", open);
    menu.setAttribute("aria-hidden", open ? "false" : "true");
    document.body.style.overflow = open ? "hidden" : "";
  };

  btn.addEventListener("click", () => {
    const open = btn.getAttribute("aria-expanded") === "true";
    setOpen(!open);
  });

  menu.querySelectorAll(".mobile-link").forEach((a) => {
    a.addEventListener("click", () => setOpen(false));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setOpen(false);
  });

  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("is-open")) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    setOpen(false);
  });

  if (!header) return;
  const onScroll = () => {
    header.classList.toggle("is-scrolled", window.scrollY > 10);
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
})();


// =========================
// ✅ PORTADA: SCROLL TOP
// =========================
(function scrollTop(){
  const btn = document.getElementById("scrollToTop");
  if (!btn) return;

  const onScroll = () => btn.classList.toggle("is-visible", window.scrollY > 450);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
})();


// =========================
// ✅ PORTADA: OPINIONES auto-slide + botones (celu y pc)
// =========================
(function reviewsAuto(){
  const track = document.getElementById("reviewsTrack");
  const prev = document.querySelector(".sl-nav-prev");
  const next = document.querySelector(".sl-nav-next");
  const box  = document.querySelector(".sl-reviews");
  if (!track || !prev || !next) return;

  const getStep = () => {
    const card = track.querySelector(".sl-review");
    if (!card) return 320;
    const gap = 12;
    return card.getBoundingClientRect().width + gap;
  };

  const scrollByStep = (dir) => {
    track.scrollBy({ left: dir * getStep(), behavior: "smooth" });
  };

  prev.addEventListener("click", () => scrollByStep(-1));
  next.addEventListener("click", () => scrollByStep(1));

  let timer = null;
  let paused = false;

  const start = () => {
    stop();
    timer = setInterval(() => {
      if (paused) return;

      const max = track.scrollWidth - track.clientWidth;
      const x = track.scrollLeft;

      if (x >= max - 5) track.scrollTo({ left: 0, behavior: "smooth" });
      else scrollByStep(1);
    }, 3200);
  };

  const stop = () => { if (timer) clearInterval(timer); timer = null; };

  const pause = () => { paused = true; };
  const resume = () => { paused = false; };

  track.addEventListener("pointerdown", pause, { passive: true });
  track.addEventListener("pointerup", resume, { passive: true });
  track.addEventListener("touchstart", pause, { passive: true });
  track.addEventListener("touchend", resume, { passive: true });
  track.addEventListener("mouseenter", pause);
  track.addEventListener("mouseleave", resume);

  // Solo corre si la sección está visible
  if ("IntersectionObserver" in window && box) {
    const io = new IntersectionObserver((entries) => {
      const e = entries[0];
      if (e.isIntersecting && e.intersectionRatio >= 0.25) start();
      else stop();
    }, { threshold: [0, .25, .5, .75, 1] });
    io.observe(box);
  } else {
    start();
  }
})();
