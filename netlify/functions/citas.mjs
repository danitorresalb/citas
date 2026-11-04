// Sistema de citas de Orientación — API en Netlify Functions + Netlify Blobs.
// Ruta pública: /api/citas/*
//
// Variables de entorno (Netlify → Site configuration → Environment variables):
//   ADMIN_PASSWORD  (obligatoria)  contraseña del panel del orientador
//   NOTIFY_EMAIL    (recomendada)  correo donde recibirás el aviso de cada reserva
//   RESEND_API_KEY  (recomendada)  clave de https://resend.com (plan gratuito)
//   TUTOR_CODE      (opcional)     código de acceso que se pide a los tutores
//   FROM_EMAIL      (opcional)     remitente con dominio verificado en Resend.
//                                  Si lo pones, también se envía confirmación al email del tutor.

import { getStore } from "@netlify/blobs";
import { timingSafeEqual, randomUUID } from "node:crypto";

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
function codigoOk(req) {
  const code = process.env.TUTOR_CODE;
  if (!code) return true;
  return igual(req.headers.get("x-codigo"), code) || esAdmin(req);
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
      return json({ requiereCodigo: !!process.env.TUTOR_CODE });
    }

    if (metodo === "GET" && ruta === "/slots") {
      if (!codigoOk(req)) return fail("Código de acceso incorrecto.", 401);
      const [slots, reservas] = await Promise.all([leerTodo(s, "slots/"), leerTodo(s, "bookings/")]);
      const ocupadas = new Set(reservas.map((r) => r.slotId));
      const libres = slots
        .filter((x) => !ocupadas.has(x.id) && !esPasado(x))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map(({ id, date, time, duration, lugar }) => ({ id, date, time, duration, lugar }));
      return json({ slots: libres });
    }

    if (metodo === "POST" && ruta === "/book") {
      if (!codigoOk(req)) return fail("Código de acceso incorrecto.", 401);
      let b;
      try { b = await req.json(); } catch { return fail("Datos no válidos."); }

      const slotId = String(b.slotId || "");
      if (!reId.test(slotId)) return fail("Hora no válida.");
      const nombre = limpiar(b.nombre, 80);
      const grupo = limpiar(b.grupo, 30);
      const tipo = b.tipo === "familia" ? "familia" : "tutor";
      if (!nombre) return fail("Indica tu nombre.");
      if (!grupo) return fail("Indica el grupo/curso.");
      const email = limpiar(b.email, 120);
      if (email && !reEmail.test(email)) return fail("El correo no parece válido.");

      const slot = await s.get(`slots/${slotId}`, { type: "json" });
      if (!slot) return fail("Esa hora ya no existe.", 404);
      if (esPasado(slot)) return fail("Esa hora ya ha pasado.", 410);

      const reserva = {
        slotId,
        nombre,
        grupo,
        tipo,
        alumno: limpiar(b.alumno, 80),
        motivo: limpiar(b.motivo, 500),
        email,
        telefono: limpiar(b.telefono, 30),
        creada: new Date().toISOString(),
        token: randomUUID(),
      };

      // Escritura condicional: solo gana UNA persona si hay reservas simultáneas.
      const res = await s.setJSON(`bookings/${slotId}`, reserva, { onlyIfNew: true });
      if (!res || res.modified !== true) {
        return fail("Lo sentimos, esa hora acaba de ser reservada por otra persona. Elige otra.", 409);
      }

      const cuando = `${fechaBonita(slot.date)} a las ${slot.time} (${slot.duration} min)`;
      const quien = tipo === "familia" ? "Cita con familia" : "Cita con el tutor/a";
      const fila = (k, v) => (v ? `<tr><td style="padding:4px 12px 4px 0;color:#666">${k}</td><td><b>${esc(v)}</b></td></tr>` : "");

      await enviarCorreo({
        to: process.env.NOTIFY_EMAIL,
        subject: `Nueva cita: ${slot.date} ${slot.time} — ${nombre} (${grupo})`,
        html: `<div style="font-family:system-ui,sans-serif;font-size:15px">
          <h2 style="margin:0 0 8px">Nueva reserva de cita</h2>
          <p style="margin:0 0 12px">${esc(cuando)}</p>
          <table>${fila("Tipo", quien)}${fila("Reservado por", nombre)}${fila("Grupo", grupo)}
          ${fila("Alumno/a", reserva.alumno)}${fila("Motivo", reserva.motivo)}
          ${fila("Email", email)}${fila("Teléfono", reserva.telefono)}${fila("Lugar", slot.lugar)}</table></div>`,
      });

      if (email && process.env.FROM_EMAIL) {
        await enviarCorreo({
          to: email,
          subject: `Cita confirmada con Orientación: ${slot.date} ${slot.time}`,
          html: `<div style="font-family:system-ui,sans-serif;font-size:15px">
            <p>Hola ${esc(nombre)}, tu cita con Orientación queda confirmada:</p>
            <p><b>${esc(cuando)}</b>${slot.lugar ? `<br>Lugar: ${esc(slot.lugar)}` : ""}</p>
            <p>Si no puedes asistir, avisa con antelación para liberar la hora.</p></div>`,
        });
      }

      return json({ ok: true, cuando, lugar: slot.lugar || "" }, 201);
    }

    // ===== Administración =====
    if (ruta.startsWith("/admin")) {
      if (!process.env.ADMIN_PASSWORD) return fail("Falta configurar ADMIN_PASSWORD en Netlify.", 500);
      if (!esAdmin(req)) return fail("Contraseña incorrecta.", 401);

      if (metodo === "GET" && ruta === "/admin/data") {
        const [slots, reservas] = await Promise.all([leerTodo(s, "slots/"), leerTodo(s, "bookings/")]);
        const porSlot = Object.fromEntries(reservas.map(({ token, ...r }) => [r.slotId, r]));
        const lista = slots
          .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
          .map((x) => ({ ...x, pasada: esPasado(x), reserva: porSlot[x.id] || null }));
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
    }

    return fail("No encontrado.", 404);
  } catch (e) {
    console.error(e);
    return fail("Error interno del servidor.", 500);
  }
};
