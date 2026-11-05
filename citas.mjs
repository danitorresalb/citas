// Sistema de citas de Orientación — API en Netlify Functions + Netlify Blobs.
// Ruta pública: /api/citas/*
//
// Variables de entorno (Netlify → Site configuration → Environment variables):
//   ADMIN_PASSWORD  (obligatoria)  contraseña del panel del orientador
//   NOTIFY_EMAIL    (recomendada)  correo donde recibirás el aviso de cada reserva
//   RESEND_API_KEY  (recomendada)  clave de https://resend.com (plan gratuito)
//   TUTOR_CODE      (opcional)     código común para todos los tutores. Solo se usa mientras
//                                  NO haya correos autorizados en el panel; en cuanto hay
//                                  alguno, el acceso pasa a ser por correo.
//   FROM_EMAIL      (opcional)     remitente con dominio verificado en Resend.

import { getStore } from "@netlify/blobs";
import { timingSafeEqual, randomUUID, createHash } from "node:crypto";

const TZ = "Europe/Madrid";
const BASE = "/api/citas";

export const config = { path: "/api/citas/*" };

const store = () => getStore({ name: "citas-orientacion", consistency: "strong" });

// ---------- utilidades ----------
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (msg, status = 400) => json({ error: msg }, status);

function ahoraMadrid() {
  const [fecha, hora] = new Date().toLocaleString("sv-SE", { timeZone: TZ }).split(" ");
  return { fecha, hora: hora.slice(0, 5) };
}
function esPasado(slot) {
  const n = ahoraMadrid();
  return slot.date < n.fecha || (slot.date === n.fecha && slot.time <= n.hora);
}
function sumarDias(fecha, n) {
  const d = new Date(`${fecha}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function igual(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && timingSafeEqual(x, y);
}
const limpiar = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const reFecha = /^\d{4}-\d{2}-\d{2}$/;
const reHora = /^([01]\d|2[0-3]):[0-5]\d$/;
const reEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function fechaValida(f) {
  if (!reFecha.test(f)) return false;
  const d = new Date(`${f}T12:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === f;
}
function fechaBonita(f) {
  return new Date(`${f}T12:00:00Z`).toLocaleDateString("es-ES", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}
const idDeSlot = (date, time) => `${date}_${time.replace(":", "")}`;
const reId = /^\d{4}-\d{2}-\d{2}_\d{4}$/;

function esAdmin(req) {
  const pass = process.env.ADMIN_PASSWORD;
  return !!pass && igual(req.headers.get("x-admin-password"), pass);
}

// Tutores autorizados: se guardan por correo (en minúsculas). El correo hace de contraseña.
const normEmail = (v) => String(v ?? "").trim().toLowerCase().slice(0, 120);
const idTutor = (email) => createHash("sha256").update(email).digest("hex");
const reIdTutor = /^[a-f0-9]{64}$/;
function credencial(req) {
  try { return decodeURIComponent(req.headers.get("x-acceso") || ""); } catch { return ""; }
}

// Decide quién puede ver/reservar horas.
//  - Admin: siempre.
//  - Si hay correos autorizados: solo quien escriba uno de ellos.
//  - Si no hay ninguno: TUTOR_CODE (si existe) o acceso libre.
async function acceso(req, s) {
  if (esAdmin(req)) return { ok: true, tutor: null };
  const { blobs } = await s.list({ prefix: "tutors/" });
  const cred = credencial(req);
  if (blobs.length) {
    const email = normEmail(cred);
    const malo = { ok: false, msg: "Ese correo no está autorizado para reservar." };
    if (!reEmail.test(email)) return malo;
    const tutor = await s.get(`tutors/${idTutor(email)}`, { type: "json" });
    return tutor ? { ok: true, tutor } : malo;
  }
  const comun = process.env.TUTOR_CODE;
  if (!comun) return { ok: true, tutor: null };
  return igual(cred, comun) ? { ok: true, tutor: null } : { ok: false, msg: "Código de acceso incorrecto." };
}

// Si había tutores guardados con el formato anterior (código personal), los pasa al formato por correo.
async function migrarTutores(s) {
  const { blobs } = await s.list({ prefix: "tutors/" });
  for (const { key } of blobs) {
    if (reIdTutor.test(key.slice(7))) continue;
    const t = await s.get(key, { type: "json" });
    if (t?.email) { const id = idTutor(normEmail(t.email)); await s.setJSON(`tutors/${id}`, { id, email: normEmail(t.email), nombre: t.nombre || "", creado: t.creado }, { onlyIfNew: true }); }
    await s.delete(key);
  }
}

// Ajustes del orientador. antelacionDias: 0 = desde hoy; 1 = desde mañana; 2 = desde pasado mañana...
async function ajustes(s) {
  const a = await s.get("config/ajustes", { type: "json" });
  const n = Math.round(Number(a?.antelacionDias));
  return { antelacionDias: n >= 0 && n <= 60 ? n : 0 };
}
// Primera fecha (inclusive) que los tutores pueden reservar.
async function fechaMinima(s) {
  return sumarDias(ahoraMadrid().fecha, (await ajustes(s)).antelacionDias);
}

async function leerTodo(s, prefix) {
  const { blobs } = await s.list({ prefix });
  const items = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return items.filter(Boolean);
}

async function enviarCorreo({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { omitido: true };
  const from = process.env.FROM_EMAIL || "Citas Orientación <onboarding@resend.dev>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!r.ok) console.error("Resend error", r.status, await r.text());
    return { ok: r.ok };
  } catch (e) {
    console.error("Error enviando correo", e);
    return { ok: false };
  }
}

// ---------- manejador ----------
export default async (req) => {
  const url = new URL(req.url);
  const ruta = url.pathname.replace(BASE, "").replace(/\/+$/, "") || "/";
  const metodo = req.method;
  const s = store();

  try {
    // ===== Público =====
    if (metodo === "GET" && ruta === "/config") {
      const { blobs } = await s.list({ prefix: "tutors/" });
      return json({ requiereCodigo: blobs.length > 0 || !!process.env.TUTOR_CODE, personal: blobs.length > 0 });
    }

    if (metodo === "GET" && ruta === "/slots") {
      const a = await acceso(req, s);
      if (!a.ok) return fail(a.msg, 401);
      const [slots, reservas, aj] = await Promise.all([leerTodo(s, "slots/"), leerTodo(s, "bookings/"), ajustes(s)]);
      const desde = sumarDias(ahoraMadrid().fecha, aj.antelacionDias);
      const ocupadas = new Set(reservas.map((r) => r.slotId));
      const libres = slots
        .filter((x) => !ocupadas.has(x.id) && !esPasado(x) && x.date >= desde)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map(({ id, date, time, duration, lugar }) => ({ id, date, time, duration, lugar }));
      const tutor = a.tutor ? { nombre: a.tutor.nombre, email: a.tutor.email } : null;
      return json({ slots: libres, tutor, desde, antelacionDias: aj.antelacionDias });
    }

    if (metodo === "POST" && ruta === "/book") {
      const a = await acceso(req, s);
      if (!a.ok) return fail(a.msg, 401);
      let b;
      try { b = await req.json(); } catch { return fail("Datos no válidos."); }

      const slotId = String(b.slotId || "");
      if (!reId.test(slotId)) return fail("Hora no válida.");
      // Con código personal, la identidad sale del tutor dado de alta (no se puede falsear).
      const nombre = a.tutor ? (a.tutor.nombre || a.tutor.email) : limpiar(b.nombre, 80);
      const email = a.tutor ? a.tutor.email : "";
      const tipo = ["familia", "alumnos"].includes(b.tipo) ? b.tipo : "tutor";
      if (!nombre) return fail("Indica tu nombre.");

      const slot = await s.get(`slots/${slotId}`, { type: "json" });
      if (!slot) return fail("Esa hora ya no existe.", 404);
      if (esPasado(slot)) return fail("Esa hora ya ha pasado.", 410);
      if (slot.date < (await fechaMinima(s))) return fail("Esa hora ya no se puede reservar: las citas se reservan con más antelación.", 403);

      const reserva = {
        slotId,
        nombre,
        email,
        tipo,
        alumno: limpiar(b.alumno, 200),
        creada: new Date().toISOString(),
        token: randomUUID(),
      };

      // Escritura condicional: solo gana UNA persona si hay reservas simultáneas.
      const res = await s.setJSON(`bookings/${slotId}`, reserva, { onlyIfNew: true });
      if (!res || res.modified !== true) {
        return fail("Lo sentimos, esa hora acaba de ser reservada por otra persona. Elige otra.", 409);
      }

      const cuando = `${fechaBonita(slot.date)} a las ${slot.time} (${slot.duration} min)`;
      const quien = { familia: "Cita con familia", alumnos: "Cita con alumnos" }[tipo] || "Cita con el tutor/a";
      const fila = (k, v) => (v ? `<tr><td style="padding:4px 12px 4px 0;color:#666">${k}</td><td><b>${esc(v)}</b></td></tr>` : "");

      await enviarCorreo({
        to: process.env.NOTIFY_EMAIL,
        subject: `Nueva cita: ${slot.date} ${slot.time} — ${nombre}`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px">
          <h2 style="margin:0 0 8px">Nueva reserva de cita</h2>
          <p style="margin:0 0 12px">${esc(cuando)}</p>
          <table>${fila("Tipo", quien)}${fila("Reservado por", nombre)}${email && email !== nombre ? fila("Correo", email) : ""}
          ${fila("Alumno/a(s)", reserva.alumno)}${fila("Lugar", slot.lugar)}</table></div>`,
      });

      return json({ ok: true, cuando, lugar: slot.lugar || "" }, 201);
    }

    // ===== Administración =====
    if (ruta.startsWith("/admin")) {
      if (!process.env.ADMIN_PASSWORD) return fail("Falta configurar ADMIN_PASSWORD en Netlify.", 500);
      if (!esAdmin(req)) return fail("Contraseña incorrecta.", 401);

      if (metodo === "GET" && ruta === "/admin/data") {
        const [slots, reservas] = await Promise.all([leerTodo(s, "slots/"), leerTodo(s, "bookings/")]);
        const desde = await fechaMinima(s);
        const porSlot = Object.fromEntries(reservas.map(({ token, ...r }) => [r.slotId, r]));
        const lista = slots
          .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
          .map((x) => ({ ...x, pasada: esPasado(x), noReservable: x.date < desde, reserva: porSlot[x.id] || null }));
        return json({ slots: lista });
      }

      if (metodo === "POST" && ruta === "/admin/slots") {
        let b;
        try { b = await req.json(); } catch { return fail("Datos no válidos."); }
        const entrada = Array.isArray(b.slots) ? b.slots.slice(0, 500) : [];
        let creadas = 0, existentes = 0, omitidas = 0;
        for (const x of entrada) {
          const date = String(x.date || ""), time = String(x.time || "");
          const duration = Math.round(Number(x.duration));
          if (!fechaValida(date) || !reHora.test(time) || !(duration >= 5 && duration <= 240)) { omitidas++; continue; }
          const slot = { id: idDeSlot(date, time), date, time, duration, lugar: limpiar(x.lugar, 80) };
          if (esPasado(slot)) { omitidas++; continue; }
          const r = await s.setJSON(`slots/${slot.id}`, slot, { onlyIfNew: true });
          if (r && r.modified === false) existentes++; else creadas++;
        }
        return json({ creadas, existentes, omitidas });
      }

      let m;
      if (metodo === "DELETE" && (m = ruta.match(/^\/admin\/slots\/([\w-]+)$/))) {
        const id = m[1];
        if (!reId.test(id)) return fail("Hora no válida.");
        if (await s.get(`bookings/${id}`)) return fail("Esa hora tiene una reserva. Cancela primero la reserva.", 409);
        await s.delete(`slots/${id}`);
        return json({ ok: true });
      }

      if (metodo === "DELETE" && (m = ruta.match(/^\/admin\/bookings\/([\w-]+)$/))) {
        const id = m[1];
        if (!reId.test(id)) return fail("Hora no válida.");
        await s.delete(`bookings/${id}`); // la hora vuelve a quedar libre
        return json({ ok: true });
      }

      // ----- Ajustes -----
      if (metodo === "GET" && ruta === "/admin/settings") return json(await ajustes(s));
      if (metodo === "POST" && ruta === "/admin/settings") {
        let b;
        try { b = await req.json(); } catch { return fail("Datos no válidos."); }
        const n = Math.round(Number(b.antelacionDias));
        if (!(n >= 0 && n <= 60)) return fail("La antelación debe estar entre 0 y 60 días.");
        await s.setJSON("config/ajustes", { antelacionDias: n });
        return json({ antelacionDias: n });
      }

      // ----- Correos autorizados (el correo hace de contraseña) -----
      if (metodo === "GET" && ruta === "/admin/tutors") {
        await migrarTutores(s);
        const tutores = (await leerTodo(s, "tutors/")).sort((x, y) => x.email.localeCompare(y.email));
        return json({ tutores });
      }

      if (metodo === "POST" && ruta === "/admin/tutors") {
        let b;
        try { b = await req.json(); } catch { return fail("Datos no válidos."); }
        await migrarTutores(s);
        const entrada = Array.isArray(b.tutores) ? b.tutores.slice(0, 300) : [];
        let creados = 0, existentes = 0, invalidos = 0;
        for (const x of entrada) {
          const email = normEmail(x.email);
          if (!reEmail.test(email)) { invalidos++; continue; }
          const id = idTutor(email);
          const r = await s.setJSON(`tutors/${id}`, { id, email, nombre: limpiar(x.nombre, 80), creado: new Date().toISOString() }, { onlyIfNew: true });
          if (r && r.modified === false) existentes++; else creados++;
        }
        return json({ creados, existentes, invalidos });
      }

      if (metodo === "DELETE" && (m = ruta.match(/^\/admin\/tutors\/([a-f0-9]{64})$/))) {
        await s.delete(`tutors/${m[1]}`);
        return json({ ok: true });
      }
    }

    return fail("No encontrado.", 404);
  } catch (e) {
    console.error(e);
    return fail("Error interno del servidor.", 500);
  }
};
