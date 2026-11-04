# Sistema de citas de Orientación (Netlify)

Los tutores ven las horas que ofreces, reservan una y esa hora desaparece para los demás.
Tú recibes un correo por cada reserva y gestionas todo desde un panel con contraseña.

- **Tutores:** `https://TU-WEB.netlify.app/citas/`
- **Panel del orientador:** `https://TU-WEB.netlify.app/citas/admin.html`

## Qué contiene

```
netlify/functions/citas.mjs   ← API (guarda horas y reservas, evita dobles reservas, envía el correo)
citas/index.html              ← página de reservas para tutores
citas/admin.html              ← tu panel (crear horas, ver/cancelar reservas)
package.json                  ← dependencia @netlify/blobs (almacenamiento incluido en Netlify)
```

No necesita base de datos externa ni Power Automate: los datos se guardan en Netlify Blobs.

## Instalación

1. **Copia** las carpetas `netlify/` y `citas/` y el `package.json` a la raíz del repositorio de tu web.
   - Si ya tienes un `package.json`, añade solo esto en `dependencies`: `"@netlify/blobs": "^11.1.7"`.
   - Si tu web publica desde una carpeta concreta (p. ej. `public` o `dist`), mete `citas/` dentro de esa carpeta; `netlify/` se queda en la raíz.
2. **Sube los cambios** a Git (GitHub/GitLab) para que Netlify despliegue.
   - Importante: arrastrar y soltar una carpeta en Netlify **no** despliega funciones. Hace falta despliegue por Git o con Netlify CLI (`netlify deploy --prod`).
3. **Variables de entorno** (Netlify → *Site configuration* → *Environment variables*):

   | Variable | Obligatoria | Para qué |
   |---|---|---|
   | `ADMIN_PASSWORD` | Sí | Contraseña de tu panel. Elige una larga. |
   | `RESEND_API_KEY` | Para el aviso | Clave gratuita de [resend.com](https://resend.com) (*API Keys*). |
   | `NOTIFY_EMAIL` | Para el aviso | Correo donde recibes cada reserva. |
   | `TUTOR_CODE` | No | Si la pones, los tutores deben escribir este código para ver las horas. Muy recomendable para que no entre cualquiera. |
   | `FROM_EMAIL` | No | Remitente con dominio verificado en Resend. Si la pones, el tutor recibe también un correo de confirmación. |

   Tras añadirlas, haz un nuevo despliegue (*Deploys* → *Trigger deploy*).
4. **Versión de Node:** el paquete pide Node 22.12 o superior. Si el despliegue falla por esto, añade la variable `NODE_VERSION` = `22`.

## Sobre el correo de aviso

Sin `FROM_EMAIL`, Resend envía desde `onboarding@resend.dev` y **solo puede entregar al correo con el que te registraste en Resend**. Por tanto, regístrate con el mismo correo que pongas en `NOTIFY_EMAIL`. Si ese correo es de Gmail, mira también la carpeta de spam la primera vez.

Si falla el correo, la reserva se guarda igualmente; lo verás en el panel y en los logs de la función (*Logs* → *Functions*).

## Uso diario

1. Entra en `/citas/admin.html` con tu contraseña.
2. Pestaña **Ofrecer horas**: elige rango de fechas, días de la semana, franja horaria y duración (p. ej. lunes y miércoles, 9:00–11:00, citas de 20 min). Pulsa *Publicar horas*.
3. Envía a los tutores el enlace `/citas/` (y el código si has puesto `TUTOR_CODE`).
4. Cuando alguien reserva, la hora desaparece de su lista y te llega el correo.
5. En **Agenda y reservas** ves quién reservó, el motivo y el contacto. *Cancelar reserva* deja la hora libre otra vez; *Eliminar hora* la retira.

## Notas

- Las reservas simultáneas están controladas: si dos personas pulsan a la vez la misma hora, solo una la consigue y la otra recibe un aviso para elegir otra.
- Las horas se interpretan en hora de España peninsular (Europe/Madrid).
- Los datos personales (nombres, correos) quedan guardados en tu cuenta de Netlify. Revisa con tu centro si necesitáis incluir un aviso de protección de datos en la página.
- Las páginas llevan `noindex`, así que los buscadores no las indexan.
