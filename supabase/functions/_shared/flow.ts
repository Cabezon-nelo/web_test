// Cliente mínimo para la API de Flow (https://www.flow.cl/docs/api.html)
// Todas las peticiones se firman con HMAC-SHA256: se concatenan los
// parámetros ordenados alfabéticamente como nombre+valor y se firma
// esa cadena con la secretKey. La firma viaja en el parámetro "s".

const encoder = new TextEncoder();

export function flowConfig() {
  const apiKey = Deno.env.get("FLOW_API_KEY");
  const secretKey = Deno.env.get("FLOW_SECRET_KEY");
  const apiUrl = Deno.env.get("FLOW_API_URL") ?? "https://sandbox.flow.cl/api";
  if (!apiKey || !secretKey) {
    throw new Error("Faltan los secretos FLOW_API_KEY / FLOW_SECRET_KEY");
  }
  return { apiKey, secretKey, apiUrl };
}

async function firmar(params: Record<string, string>, secretKey: string): Promise<string> {
  const cadena = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join("");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const firma = await crypto.subtle.sign("HMAC", key, encoder.encode(cadena));
  return Array.from(new Uint8Array(firma))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function flowPost(
  endpoint: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { secretKey, apiUrl } = flowConfig();
  const firmados = { ...params, s: await firmar(params, secretKey) };
  const resp = await fetch(`${apiUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(firmados),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Flow ${endpoint} respondió ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

export async function flowGet(
  endpoint: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { secretKey, apiUrl } = flowConfig();
  const firmados = { ...params, s: await firmar(params, secretKey) };
  const resp = await fetch(`${apiUrl}${endpoint}?${new URLSearchParams(firmados)}`);
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Flow ${endpoint} respondió ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}
