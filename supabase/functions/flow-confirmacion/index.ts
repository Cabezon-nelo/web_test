// Webhook que Flow llama (servidor a servidor) cuando cambia el estado
// de un pago. Nunca confiamos en el aviso: consultamos el estado real
// con payment/getStatus firmado, y solo entonces marcamos la orden
// como pagada y asignamos los números.
// Desplegar con --no-verify-jwt (Flow no envía JWT de Supabase).

import { createClient } from "npm:@supabase/supabase-js@2";
import { flowConfig, flowGet } from "../_shared/flow.ts";

// Estados de Flow: 1 pendiente, 2 pagada, 3 rechazada, 4 anulada
const ESTADOS: Record<number, string> = { 3: "rechazada", 4: "anulada" };

Deno.serve(async (req) => {
  try {
    const form = await req.formData();
    const token = form.get("token");
    if (typeof token !== "string" || !token) {
      return new Response("Falta token", { status: 400 });
    }

    const { apiKey } = flowConfig();
    const estado = await flowGet("/payment/getStatus", { apiKey, token });
    const ordenId = estado.commerceOrder as string;
    const flowStatus = Number(estado.status);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    if (flowStatus === 2) {
      await admin
        .from("ordenes")
        .update({ estado: "pagada", pagada_en: new Date().toISOString() })
        .eq("id", ordenId)
        .eq("estado", "pendiente");
      // Idempotente: si Flow notifica dos veces, devuelve los mismos números
      const { error } = await admin.rpc("asignar_numeros", { p_orden_id: ordenId });
      if (error) throw error;
    } else if (flowStatus in ESTADOS) {
      await admin
        .from("ordenes")
        .update({ estado: ESTADOS[flowStatus] })
        .eq("id", ordenId)
        .eq("estado", "pendiente");
    }

    return new Response("OK");
  } catch (e) {
    console.error("flow-confirmacion:", e);
    return new Response("Error", { status: 500 });
  }
});
