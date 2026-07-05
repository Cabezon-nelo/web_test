// Lógica de la página pública: sesión, sorteo activo, compra y mis números.

const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const formatoCLP = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" });

let sesionActual = null;
let sorteoActivo = null;

// ---------- Arranque ----------

document.addEventListener("DOMContentLoaded", async () => {
  const { data: { session } } = await db.auth.getSession();
  sesionActual = session;

  db.auth.onAuthStateChange((_evento, session) => {
    sesionActual = session;
    renderizarNav();
    renderizarAuth();
    cargarMisNumeros();
  });

  renderizarNav();
  renderizarAuth();
  await cargarSorteo();
  await cargarMisNumeros();
  await procesarRetornoFlow();
});

// ---------- Navegación / sesión ----------

async function renderizarNav() {
  const nav = document.getElementById("nav-sesion");
  if (!sesionActual) {
    nav.innerHTML = '<button class="boton-secundario" onclick="irAlAcceso()">Iniciar sesión</button>';
    return;
  }
  const email = sesionActual.user.email;
  let enlaceAdmin = "";
  const { data: perfil } = await db
    .from("perfiles")
    .select("es_admin")
    .eq("id", sesionActual.user.id)
    .single();
  if (perfil && perfil.es_admin) {
    enlaceAdmin = '<a href="admin.html">Panel admin</a>';
  }
  nav.innerHTML = `
    ${enlaceAdmin}
    <span class="usuario">${email}</span>
    <button class="boton-secundario" onclick="cerrarSesion()">Salir</button>
  `;
}

function renderizarAuth() {
  const seccion = document.getElementById("seccion-auth");
  seccion.classList.toggle("oculto", !!sesionActual);
  document.getElementById("seccion-numeros").classList.toggle("oculto", !sesionActual);
}

function irAlAcceso() {
  document.getElementById("seccion-auth").scrollIntoView({ behavior: "smooth" });
}

function mostrarTab(cual) {
  document.getElementById("tab-login").classList.toggle("activa", cual === "login");
  document.getElementById("tab-registro").classList.toggle("activa", cual === "registro");
  document.getElementById("form-login").classList.toggle("oculto", cual !== "login");
  document.getElementById("form-registro").classList.toggle("oculto", cual !== "registro");
  ocultarMensajeAuth();
}

function mensajeAuth(texto, tipo) {
  const p = document.getElementById("auth-mensaje");
  p.textContent = texto;
  p.className = `mensaje ${tipo || ""}`;
}

function ocultarMensajeAuth() {
  document.getElementById("auth-mensaje").classList.add("oculto");
}

async function registrarse(evento) {
  evento.preventDefault();
  const nombre = document.getElementById("registro-nombre").value.trim();
  const email = document.getElementById("registro-email").value.trim();
  const password = document.getElementById("registro-password").value;

  const { error } = await db.auth.signUp({
    email,
    password,
    options: { data: { nombre } },
  });
  if (error) {
    mensajeAuth(traducirErrorAuth(error.message), "error");
    return;
  }
  mensajeAuth(
    "Cuenta creada. Te enviamos un correo de verificación: ábrelo y confirma tu cuenta antes de comprar.",
    "exito",
  );
}

async function iniciarSesion(evento) {
  evento.preventDefault();
  const email = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;

  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) {
    mensajeAuth(traducirErrorAuth(error.message), "error");
    return;
  }
  ocultarMensajeAuth();
}

async function cerrarSesion() {
  await db.auth.signOut();
}

function traducirErrorAuth(mensaje) {
  if (mensaje.includes("Invalid login credentials")) return "Correo o contraseña incorrectos.";
  if (mensaje.includes("Email not confirmed")) return "Tu correo aún no está verificado. Revisa tu bandeja de entrada.";
  if (mensaje.includes("already registered")) return "Ese correo ya tiene una cuenta. Inicia sesión.";
  return `No se pudo completar la operación: ${mensaje}`;
}

// ---------- Sorteo activo ----------

async function cargarSorteo() {
  const seccion = document.getElementById("seccion-sorteo");

  const { data: sorteo, error } = await db
    .from("sorteos")
    .select("*")
    .eq("estado", "activo")
    .maybeSingle();

  if (error) {
    seccion.innerHTML = '<p class="mensaje error">No se pudo cargar el sorteo. Recarga la página.</p>';
    return;
  }
  if (!sorteo) {
    await mostrarUltimoResultado(seccion);
    return;
  }

  sorteoActivo = sorteo;
  const { data: vendidos } = await db.rpc("numeros_vendidos", { p_sorteo: sorteo.id });
  const total = sorteo.rango_actual;
  const porcentaje = total ? Math.min(100, Math.round(((vendidos || 0) / total) * 100)) : 0;

  const imagen = sorteo.imagen_url
    ? `<img class="sorteo-imagen" src="${sorteo.imagen_url}" alt="${sorteo.nombre}">`
    : '<div class="sorteo-imagen-vacia">🎁</div>';

  const opciones = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return `<option value="${n}">${n} ticket${n > 1 ? "s" : ""} — ${formatoCLP.format(n * sorteo.precio)}</option>`;
  }).join("");

  seccion.innerHTML = `
    <div class="sorteo-grid">
      <div>${imagen}</div>
      <div>
        <span class="etiqueta">Sorteo activo</span>
        <h1 class="sorteo-nombre">${sorteo.nombre}</h1>
        <p class="sorteo-descripcion">${sorteo.descripcion || ""}</p>
        <p class="sorteo-precio">${formatoCLP.format(sorteo.precio)} <small>por ticket</small></p>
        <div class="progreso"><div class="progreso-relleno" style="width:${porcentaje}%"></div></div>
        <p class="progreso-texto">${vendidos || 0} de ${total} números asignados</p>
        <div class="compra-controles">
          <label for="compra-cantidad">Cantidad</label>
          <select id="compra-cantidad">${opciones}</select>
        </div>
        <button class="boton-principal" id="boton-comprar" onclick="comprar()">Comprar y participar</button>
        <p class="nota-pago">Pago seguro con Flow — Webpay, tarjetas de crédito y débito.
        Cada ticket incluye de regalo un número único de sorteo.</p>
      </div>
    </div>
  `;
}

async function mostrarUltimoResultado(seccion) {
  const { data: sorteado } = await db
    .from("sorteos")
    .select("nombre, numero_ganador, fecha_sorteo")
    .eq("estado", "sorteado")
    .order("fecha_sorteo", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sorteado && sorteado.numero_ganador) {
    seccion.innerHTML = `
      <div class="ganador">
        <span class="etiqueta">Último sorteo realizado</span>
        <h1 class="sorteo-nombre">${sorteado.nombre}</h1>
        <p>Número ganador</p>
        <div class="numero-grande">N° ${sorteado.numero_ganador}</div>
        <p class="sorteo-descripcion">Pronto anunciaremos el próximo sorteo.</p>
      </div>
    `;
  } else {
    seccion.innerHTML = `
      <h1 class="sorteo-nombre">No hay sorteos activos</h1>
      <p class="sorteo-descripcion">Vuelve pronto: estamos preparando el próximo sorteo.</p>
    `;
  }
}

// ---------- Compra ----------

async function comprar() {
  if (!sesionActual) {
    mostrarTab("registro");
    document.getElementById("seccion-auth").classList.remove("oculto");
    irAlAcceso();
    mensajeAuth("Crea tu cuenta o inicia sesión para comprar tu ticket.", "");
    return;
  }

  const boton = document.getElementById("boton-comprar");
  const cantidad = parseInt(document.getElementById("compra-cantidad").value, 10);
  boton.disabled = true;
  boton.textContent = "Conectando con Flow…";

  const { data, error } = await db.functions.invoke("crear-pago", {
    body: { cantidad },
  });

  if (error || !data || !data.url) {
    let detalle = "No se pudo iniciar el pago. Intenta de nuevo.";
    if (error && error.context) {
      try {
        const cuerpo = await error.context.json();
        if (cuerpo.error) detalle = cuerpo.error;
      } catch (_e) { /* respuesta sin JSON */ }
    }
    boton.disabled = false;
    boton.textContent = "Comprar y participar";
    alert(detalle);
    return;
  }

  window.location.href = data.url;
}

// ---------- Retorno desde Flow ----------

async function procesarRetornoFlow() {
  const token = new URLSearchParams(window.location.search).get("flow_token");
  if (!token) return;

  const seccion = document.getElementById("seccion-resultado");
  const contenido = document.getElementById("resultado-contenido");
  seccion.classList.remove("oculto");
  seccion.scrollIntoView();

  if (!sesionActual) {
    contenido.innerHTML = '<p class="mensaje">Inicia sesión para ver el resultado de tu compra.</p>';
    return;
  }

  contenido.innerHTML = '<p class="cargando">Confirmando tu pago con Flow…</p>';

  // La confirmación llega por webhook; puede tardar unos segundos.
  for (let intento = 0; intento < 10; intento++) {
    const { data: orden } = await db
      .from("ordenes")
      .select("id, estado, cantidad")
      .eq("flow_token", token)
      .maybeSingle();

    if (orden && orden.estado === "pagada") {
      const { data: numeros } = await db
        .from("numeros")
        .select("numero")
        .eq("orden_id", orden.id)
        .order("numero");
      const chips = (numeros || [])
        .map((n) => `<span class="numero-chip">N° ${n.numero}</span>`)
        .join("");
      contenido.innerHTML = `
        <p class="mensaje exito">¡Pago confirmado! Estos son tus números de sorteo:</p>
        <div class="numeros-lista" style="margin-top:12px">${chips}</div>
      `;
      cargarMisNumeros();
      cargarSorteo();
      limpiarURL();
      return;
    }

    if (orden && (orden.estado === "rechazada" || orden.estado === "anulada")) {
      contenido.innerHTML =
        '<p class="mensaje error">El pago no se completó. No se hizo ningún cargo definitivo; puedes intentarlo de nuevo.</p>';
      limpiarURL();
      return;
    }

    await new Promise((resolver) => setTimeout(resolver, 2000));
  }

  contenido.innerHTML = `
    <p class="mensaje">Tu pago está en proceso de confirmación. Tus números aparecerán en
    "Mis tickets y números" apenas Flow confirme (normalmente menos de un minuto).</p>
  `;
  limpiarURL();
}

function limpiarURL() {
  window.history.replaceState({}, "", window.location.pathname);
}

// ---------- Mis números ----------

async function cargarMisNumeros() {
  if (!sesionActual) return;
  const lista = document.getElementById("lista-numeros");

  const [{ data: numeros }, { data: ordenes }] = await Promise.all([
    db.from("numeros").select("numero, sorteo_id, sorteos(nombre)").order("asignado_en", { ascending: false }),
    db.from("ordenes").select("cantidad, monto, estado, creado_en").order("creado_en", { ascending: false }).limit(10),
  ]);

  let html = "";

  if (numeros && numeros.length) {
    const chips = numeros
      .map((n) => `<span class="numero-chip">N° ${n.numero}<small>${n.sorteos ? n.sorteos.nombre : ""}</small></span>`)
      .join("");
    html += `<div class="numeros-lista">${chips}</div>`;
  } else {
    html += '<p class="sorteo-descripcion">Todavía no tienes números. Compra un ticket para participar.</p>';
  }

  if (ordenes && ordenes.length) {
    const filas = ordenes
      .map((o) => {
        const fecha = new Date(o.creado_en).toLocaleDateString("es-CL");
        return `<div class="orden-item">
          <span>${fecha} — ${o.cantidad} ticket(s)</span>
          <span>${formatoCLP.format(o.monto)} · ${o.estado}</span>
        </div>`;
      })
      .join("");
    html += `<h3 style="margin:18px 0 6px">Historial de compras</h3>${filas}`;
  }

  lista.innerHTML = html;
}
