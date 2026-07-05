// Panel de administración: gestión del sorteo, órdenes y usuarios.
// El acceso real lo protegen las políticas RLS (es_admin); este guard
// solo evita mostrar una página vacía a quien no corresponde.

const db = supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

const formatoCLP = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP" });

document.addEventListener("DOMContentLoaded", async () => {
  const { data: { session } } = await db.auth.getSession();
  const guard = document.getElementById("admin-guard");

  if (!session) {
    guard.innerHTML = '<p class="mensaje error">Debes iniciar sesión. <a href="index.html">Volver al sitio</a></p>';
    return;
  }

  const { data: perfil } = await db
    .from("perfiles")
    .select("es_admin")
    .eq("id", session.user.id)
    .single();

  if (!perfil || !perfil.es_admin) {
    guard.innerHTML = '<p class="mensaje error">Esta cuenta no tiene permisos de administración. <a href="index.html">Volver al sitio</a></p>';
    return;
  }

  guard.classList.add("oculto");
  document.getElementById("admin-contenido").classList.remove("oculto");

  await Promise.all([cargarSorteoAdmin(), cargarOrdenes(), cargarUsuarios()]);
});

async function cerrarSesion() {
  await db.auth.signOut();
  window.location.href = "index.html";
}

// ---------- Sorteo ----------

async function cargarSorteoAdmin() {
  const cont = document.getElementById("admin-sorteo");

  const { data: sorteo } = await db
    .from("sorteos")
    .select("*")
    .eq("estado", "activo")
    .maybeSingle();

  if (!sorteo) {
    cont.innerHTML = `
      <p class="sorteo-descripcion">No hay sorteo activo. Crea uno nuevo:</p>
      <form onsubmit="crearSorteo(event)">
        <label>Nombre del producto
          <input type="text" id="nuevo-nombre" required>
        </label>
        <label>Descripción
          <input type="text" id="nuevo-descripcion">
        </label>
        <label>URL de la imagen (opcional)
          <input type="url" id="nuevo-imagen">
        </label>
        <label>Precio por ticket (CLP)
          <input type="number" id="nuevo-precio" required min="1" step="1">
        </label>
        <label>Rango mínimo de números (el rango crece solo si se llena)
          <input type="number" id="nuevo-rango" required min="10" step="1" value="100">
        </label>
        <button type="submit" class="boton-principal">Crear y activar sorteo</button>
      </form>
      <p id="sorteo-mensaje" class="mensaje oculto"></p>
    `;
    return;
  }

  const [{ data: vendidos }, { data: pagadas }] = await Promise.all([
    db.rpc("numeros_vendidos", { p_sorteo: sorteo.id }),
    db.from("ordenes").select("monto").eq("sorteo_id", sorteo.id).eq("estado", "pagada"),
  ]);
  const recaudado = (pagadas || []).reduce((suma, o) => suma + o.monto, 0);

  cont.innerHTML = `
    <span class="etiqueta">Activo</span>
    <h3 class="sorteo-nombre">${sorteo.nombre}</h3>
    <div class="estadisticas">
      <div class="estadistica"><div class="valor">${formatoCLP.format(sorteo.precio)}</div><div class="titulo">Precio por ticket</div></div>
      <div class="estadistica"><div class="valor">${vendidos || 0} / ${sorteo.rango_actual}</div><div class="titulo">Números asignados</div></div>
      <div class="estadistica"><div class="valor">${formatoCLP.format(recaudado)}</div><div class="titulo">Recaudado (pagado)</div></div>
    </div>
    <div style="display:flex; gap:10px; flex-wrap:wrap">
      <button class="boton-secundario" onclick="cerrarSorteo('${sorteo.id}')">Cerrar ventas</button>
      <button class="boton-principal" style="width:auto" onclick="sortearGanador('${sorteo.id}')">Sortear ganador</button>
    </div>
    <p id="sorteo-mensaje" class="mensaje oculto"></p>
    <div id="sorteo-ganador"></div>
  `;
}

function mensajeSorteo(texto, tipo) {
  const p = document.getElementById("sorteo-mensaje");
  p.textContent = texto;
  p.className = `mensaje ${tipo || ""}`;
}

async function crearSorteo(evento) {
  evento.preventDefault();
  const { error } = await db.from("sorteos").insert({
    nombre: document.getElementById("nuevo-nombre").value.trim(),
    descripcion: document.getElementById("nuevo-descripcion").value.trim(),
    imagen_url: document.getElementById("nuevo-imagen").value.trim() || null,
    precio: parseInt(document.getElementById("nuevo-precio").value, 10),
    rango_minimo: parseInt(document.getElementById("nuevo-rango").value, 10),
    estado: "activo",
  });
  if (error) {
    mensajeSorteo(`No se pudo crear el sorteo: ${error.message}`, "error");
    return;
  }
  await cargarSorteoAdmin();
}

async function cerrarSorteo(id) {
  if (!confirm("¿Cerrar las ventas de este sorteo? Nadie más podrá comprar.")) return;
  const { error } = await db.from("sorteos").update({ estado: "cerrado" }).eq("id", id);
  if (error) {
    mensajeSorteo(`No se pudo cerrar: ${error.message}`, "error");
    return;
  }
  await cargarSorteoAdmin();
}

async function sortearGanador(id) {
  if (!confirm("¿Sortear el ganador ahora? Esta acción cierra el sorteo y no se puede repetir.")) return;
  const { data, error } = await db.rpc("sortear_ganador", { p_sorteo: id });
  if (error) {
    mensajeSorteo(`No se pudo sortear: ${error.message}`, "error");
    return;
  }
  const ganador = data && data[0];
  document.getElementById("sorteo-ganador").innerHTML = `
    <div class="ganador">
      <p>Número ganador</p>
      <div class="numero-grande">N° ${ganador.numero}</div>
      <p><strong>${ganador.nombre || "(sin nombre)"}</strong> — ${ganador.email}</p>
    </div>
  `;
}

// ---------- Órdenes ----------

async function cargarOrdenes() {
  const cont = document.getElementById("admin-ordenes");
  const { data: ordenes, error } = await db
    .from("ordenes")
    .select("cantidad, monto, estado, creado_en, flow_order, perfiles(email, nombre)")
    .order("creado_en", { ascending: false })
    .limit(100);

  if (error) {
    cont.innerHTML = `<p class="mensaje error">Error al cargar órdenes: ${error.message}</p>`;
    return;
  }
  if (!ordenes || !ordenes.length) {
    cont.innerHTML = '<p class="sorteo-descripcion">Aún no hay compras.</p>';
    return;
  }

  const filas = ordenes
    .map((o) => {
      const fecha = new Date(o.creado_en).toLocaleString("es-CL");
      const comprador = o.perfiles ? `${o.perfiles.nombre || ""} ${o.perfiles.email}` : "—";
      return `<tr>
        <td>${fecha}</td>
        <td>${comprador}</td>
        <td>${o.cantidad}</td>
        <td>${formatoCLP.format(o.monto)}</td>
        <td>${o.estado}</td>
        <td>${o.flow_order || "—"}</td>
      </tr>`;
    })
    .join("");

  cont.innerHTML = `
    <table class="tabla">
      <thead><tr><th>Fecha</th><th>Comprador</th><th>Tickets</th><th>Monto</th><th>Estado</th><th>Orden Flow</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
  `;
}

// ---------- Usuarios ----------

async function cargarUsuarios() {
  const cont = document.getElementById("admin-usuarios");
  const { data: usuarios, error } = await db
    .from("perfiles")
    .select("id, email, nombre, es_admin, bloqueado, creado_en")
    .order("creado_en", { ascending: false });

  if (error) {
    cont.innerHTML = `<p class="mensaje error">Error al cargar usuarios: ${error.message}</p>`;
    return;
  }

  const filas = (usuarios || [])
    .map((u) => {
      const fecha = new Date(u.creado_en).toLocaleDateString("es-CL");
      const rol = u.es_admin ? "Admin" : "Usuario";
      const estado = u.bloqueado ? "Bloqueado" : "Autorizado";
      const accion = u.es_admin
        ? "—"
        : `<button class="boton-secundario" onclick="alternarBloqueo('${u.id}', ${u.bloqueado})">
            ${u.bloqueado ? "Autorizar" : "Bloquear"}
          </button>`;
      return `<tr>
        <td>${u.nombre || "—"}</td>
        <td>${u.email}</td>
        <td>${fecha}</td>
        <td>${rol}</td>
        <td>${estado}</td>
        <td>${accion}</td>
      </tr>`;
    })
    .join("");

  cont.innerHTML = `
    <table class="tabla">
      <thead><tr><th>Nombre</th><th>Correo</th><th>Registro</th><th>Rol</th><th>Estado</th><th></th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
  `;
}

async function alternarBloqueo(id, estabaBloqueado) {
  const { error } = await db
    .from("perfiles")
    .update({ bloqueado: !estabaBloqueado })
    .eq("id", id);
  if (error) {
    alert(`No se pudo actualizar el usuario: ${error.message}`);
    return;
  }
  await cargarUsuarios();
}
