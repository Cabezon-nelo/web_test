// Crea una orden de compra y pide a Flow la URL de pago.
// La llama el frontend con la sesión del usuario (JWT en Authorization).
// Body esperado: { "cantidad": 1..20 }

import { createClient } from "npm:@supabase/supabase-js@2";
import { flowConfig, flowPost } from "../_shared/flow.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Identificar al usuario desde su JWT
    const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) {
      return json({ error: "Debes iniciar sesión para comprar" }, 401);
    }
    if (!user.email_confirmed_at) {
      return json({ error: "Verifica tu correo antes de comprar" }, 403);
    }

    const { data: perfil } = await admin
      .from("perfiles")
      .select("bloqueado")
      .eq("id", user.id)
      .single();
    if (!perfil || perfil.bloqueado) {
      return json({ error: "Tu cuenta no está autorizada para comprar" }, 403);
    }

    const { cantidad } = await req.json();
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 20) {
      return json({ error: "Cantidad inválida (mínimo 1, máximo 20)" }, 400);
    }

    const { data: sorteo } = await admin
      .from("sorteos")
      .select("id, nombre, precio")
      .eq("estado", "activo")
      .single();
    if (!sorteo) {
      return json({ error: "No hay ningún sorteo activo en este momento" }, 400);
    }

    const monto = sorteo.precio * cantidad;

    const { data: orden, error: errOrden } = await admin
      .from("ordenes")
      .insert({
        user_id: user.id,
        sorteo_id: sorteo.id,
        cantidad,
        monto,
      })
      .select("id")
      .single();
    if (errOrden) throw errOrden;

    const { apiKey } = flowConfig();
    const functionsUrl = `${supabaseUrl}/functions/v1`;
    const pago = await flowPost("/payment/create", {
      apiKey,
      commerceOrder: orden.id,
      subject: `${cantidad} ticket(s) — ${sorteo.nombre}`,
      currency: "CLP",
      amount: String(monto),
      email: user.email!,
      urlConfirmation: `${functionsUrl}/flow-confirmacion`,
      urlReturn: `${functionsUrl}/flow-retorno`,
    });

    await admin
      .from("ordenes")
      .update({ flow_token: pago.token, flow_order: pago.flowOrder })
      .eq("id", orden.id);

    return json({ url: `${pago.url}?token=${pago.token}` });
  } catch (e) {
    console.error("crear-pago:", e);
    return json({ error: "No se pudo iniciar el pago. Intenta de nuevo." }, 500);
  }
});
