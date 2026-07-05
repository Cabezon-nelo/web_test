// Cuando el usuario termina de pagar, Flow lo devuelve con un POST a esta
// URL. GitHub Pages es estático y no acepta POST, así que esta función
// recibe el POST y redirige (303) al sitio con el token en la URL, donde
// el frontend muestra el resultado de la compra.
// Desplegar con --no-verify-jwt.

Deno.serve(async (req) => {
  let token = "";
  try {
    if (req.method === "POST") {
      const form = await req.formData();
      token = String(form.get("token") ?? "");
    } else {
      token = new URL(req.url).searchParams.get("token") ?? "";
    }
  } catch (_e) {
    token = "";
  }

  const sitio = Deno.env.get("SITE_URL") ?? "/";
  const destino = token ? `${sitio}?flow_token=${encodeURIComponent(token)}` : sitio;
  return new Response(null, { status: 303, headers: { Location: destino } });
});
