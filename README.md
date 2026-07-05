# Web de sorteos

Sitio de venta de tickets con sorteo asociado: cada compra entrega el producto
más un **número único de sorteo de regalo**, asignado al azar solo cuando el
pago queda confirmado.

## Arquitectura

| Pieza | Dónde vive | Qué hace |
|---|---|---|
| Frontend (`index.html`, `admin.html`) | GitHub Pages (este repo) | Página pública y panel de administración |
| Base de datos y autenticación | Supabase (Postgres + Auth) | Usuarios, sorteos, órdenes y números, protegidos con RLS |
| Pagos | Flow (sandbox o producción) | Webpay, tarjetas de crédito y débito |
| Lógica de pago | Supabase Edge Functions | Firma las peticiones a Flow (la clave secreta nunca toca el navegador) |

Flujo de compra:

1. El usuario se registra, verifica su correo e inicia sesión.
2. Presiona "Comprar" → la función `crear-pago` crea la orden y pide a Flow una URL de pago.
3. El usuario paga en Flow.
4. Flow notifica a `flow-confirmacion` (webhook servidor a servidor) → se verifica el
   estado real con `payment/getStatus`, se marca la orden como pagada y se asignan
   los números **de forma atómica** (imposible que dos personas reciban el mismo).
5. Flow devuelve al usuario vía `flow-retorno`, que lo redirige al sitio donde ve sus números.

El rango de números parte en el mínimo configurado del sorteo y **crece
automáticamente** cuando queda menos del 20% disponible.

## Puesta en marcha

### 1. Supabase

1. Crea un proyecto en [supabase.com](https://supabase.com) (plan gratuito sirve).
2. En **SQL Editor**, pega y ejecuta el contenido completo de [`supabase/schema.sql`](supabase/schema.sql).
3. En **Authentication > Providers > Email**, verifica que "Confirm email" esté activado
   (viene activado por defecto). En **Authentication > URL Configuration**, agrega la URL
   del sitio (GitHub Pages) como Site URL y Redirect URL.
4. Copia de **Settings > API** la `URL` del proyecto y la `anon public` key, y pégalas
   en [`js/config.js`](js/config.js).

### 2. Flow (sandbox para pruebas)

1. Crea una cuenta en el sandbox: [sandbox.flow.cl](https://sandbox.flow.cl).
2. En el panel de Flow, sección de credenciales de integración, copia tu **apiKey** y **secretKey**.
3. Cuando quieras pasar a producción: cuenta real en [flow.cl](https://www.flow.cl),
   nuevas credenciales, y cambiar el secreto `FLOW_API_URL` a `https://www.flow.cl/api`.

### 3. Edge Functions

Con la [CLI de Supabase](https://supabase.com/docs/guides/functions) instalada
(`brew install supabase/tap/supabase`):

```bash
supabase login
supabase link --project-ref TU_PROJECT_REF

# Secretos (la secretKey de Flow SOLO vive aquí)
supabase secrets set FLOW_API_KEY="tu-apikey-de-flow"
supabase secrets set FLOW_SECRET_KEY="tu-secretkey-de-flow"
supabase secrets set FLOW_API_URL="https://sandbox.flow.cl/api"
supabase secrets set SITE_URL="https://cabezon-nelo.github.io/web_test/"

# Desplegar las tres funciones
supabase functions deploy crear-pago
supabase functions deploy flow-confirmacion --no-verify-jwt
supabase functions deploy flow-retorno --no-verify-jwt
```

`--no-verify-jwt` es necesario en las dos funciones que llama Flow directamente,
porque Flow no envía tokens de Supabase. La seguridad ahí la da la firma HMAC:
todo se verifica contra la API de Flow antes de tocar la base de datos.

### 4. Crear el primer administrador

1. Regístrate en la web con tu correo y verifícalo.
2. En el SQL Editor de Supabase ejecuta:

```sql
update public.perfiles set es_admin = true where email = 'tu@correo.cl';
```

3. Recarga la web: aparecerá el enlace "Panel admin", donde puedes crear el
   primer sorteo, ver las órdenes, bloquear usuarios y sortear al ganador.

### 5. GitHub Pages

En **Settings > Pages** del repo: Source = `Deploy from a branch`, rama `main`, carpeta `/`.

## Estructura del repo

```
index.html                  Página pública (sorteo, registro, compra, mis números)
admin.html                  Panel de administración
css/estilos.css             Estilos compartidos
js/config.js                URL y anon key de Supabase (editar al configurar)
js/app.js                   Lógica de la página pública
js/admin.js                 Lógica del panel admin
supabase/schema.sql         Esquema completo: tablas, RLS, funciones
supabase/functions/
  _shared/flow.ts           Cliente de la API de Flow (firma HMAC-SHA256)
  crear-pago/               Crea la orden y obtiene la URL de pago
  flow-confirmacion/        Webhook de confirmación de pago (asigna números)
  flow-retorno/             Redirige al usuario de vuelta al sitio tras pagar
```

## Decisiones de diseño

- **Se vende un ticket, no un número**: el número de sorteo es un regalo asociado
  a la compra. Los textos del sitio reflejan esto.
- **Un solo sorteo activo a la vez**, garantizado por un índice único en la base de datos.
- **Números al azar y solo tras pago confirmado**: la función `asignar_numeros`
  bloquea el sorteo mientras asigna (sin duplicados posibles) y es idempotente
  (si Flow notifica dos veces, no se duplican números).
- **Registro automático con verificación de correo**; el admin puede bloquear
  cuentas desde el panel (una cuenta bloqueada no puede comprar).
- **Máximo 20 tickets por compra** (configurable en `schema.sql` y `crear-pago`).
