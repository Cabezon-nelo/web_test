-- ============================================================
-- Esquema inicial — Web de sorteos
-- Ejecutar UNA VEZ en el editor SQL de Supabase (SQL Editor > New query)
-- ============================================================

-- ============ PERFILES ============
-- Un perfil por usuario registrado en auth.users. Se crea automáticamente
-- al registrarse (ver trigger más abajo).
create table public.perfiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  nombre text,
  es_admin boolean not null default false,
  bloqueado boolean not null default false,
  creado_en timestamptz not null default now()
);

alter table public.perfiles enable row level security;

-- Función auxiliar para las políticas RLS. SECURITY DEFINER evita la
-- recursión infinita que ocurre si una política de perfiles consulta perfiles.
create or replace function public.es_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select coalesce((select es_admin from perfiles where id = auth.uid()), false);
$$;

create policy "perfil propio o admin" on public.perfiles
  for select using (auth.uid() = id or public.es_admin());

create policy "admin modifica perfiles" on public.perfiles
  for update using (public.es_admin());

-- Crear el perfil automáticamente cuando alguien se registra
create or replace function public.crear_perfil()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.perfiles (id, email, nombre)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'nombre', ''));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.crear_perfil();

-- ============ SORTEOS ============
create table public.sorteos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  descripcion text,
  imagen_url text,
  precio integer not null check (precio > 0),                -- CLP por ticket
  rango_minimo integer not null default 100 check (rango_minimo > 0),
  rango_actual integer,                                       -- tope actual de números; parte igual a rango_minimo
  estado text not null default 'activo'
    check (estado in ('borrador', 'activo', 'cerrado', 'sorteado')),
  numero_ganador integer,
  fecha_sorteo timestamptz,
  creado_en timestamptz not null default now()
);

-- Solo puede existir UN sorteo activo a la vez
create unique index un_solo_sorteo_activo on public.sorteos ((true)) where estado = 'activo';

create or replace function public.sorteo_defaults()
returns trigger
language plpgsql
as $$
begin
  if new.rango_actual is null then
    new.rango_actual := new.rango_minimo;
  end if;
  return new;
end;
$$;

create trigger sorteo_before_insert
  before insert on public.sorteos
  for each row execute function public.sorteo_defaults();

alter table public.sorteos enable row level security;

create policy "sorteos visibles para todos" on public.sorteos
  for select using (true);

create policy "admin crea sorteos" on public.sorteos
  for insert with check (public.es_admin());

create policy "admin modifica sorteos" on public.sorteos
  for update using (public.es_admin());

-- ============ ORDENES ============
-- Una orden = una compra (puede incluir varios tickets).
-- Solo las Edge Functions (service role) insertan y cambian el estado.
create table public.ordenes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.perfiles (id),
  sorteo_id uuid not null references public.sorteos (id),
  cantidad integer not null check (cantidad between 1 and 20),
  monto integer not null check (monto > 0),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'pagada', 'rechazada', 'anulada')),
  flow_token text,
  flow_order bigint,
  creado_en timestamptz not null default now(),
  pagada_en timestamptz
);

alter table public.ordenes enable row level security;

create policy "orden propia o admin" on public.ordenes
  for select using (auth.uid() = user_id or public.es_admin());

-- ============ NUMEROS ============
-- Los números de sorteo asignados. Solo el backend los inserta,
-- únicamente después de que Flow confirma el pago.
create table public.numeros (
  id uuid primary key default gen_random_uuid(),
  sorteo_id uuid not null references public.sorteos (id),
  numero integer not null,
  user_id uuid not null references public.perfiles (id),
  orden_id uuid not null references public.ordenes (id),
  asignado_en timestamptz not null default now(),
  unique (sorteo_id, numero)
);

alter table public.numeros enable row level security;

create policy "numeros propios o admin" on public.numeros
  for select using (auth.uid() = user_id or public.es_admin());

-- Contador público para la barra de progreso (visible sin sesión,
-- no expone quién es dueño de cada número)
create or replace function public.numeros_vendidos(p_sorteo uuid)
returns integer
language sql stable security definer
set search_path = public
as $$
  select count(*)::integer from numeros where sorteo_id = p_sorteo;
$$;

grant execute on function public.numeros_vendidos(uuid) to anon, authenticated;

-- ============ ASIGNACION ATOMICA DE NUMEROS ============
-- La llama la Edge Function flow-confirmacion cuando el pago queda pagado.
-- Bloquea el sorteo (FOR UPDATE) para que dos pagos simultáneos jamás
-- reciban el mismo número. Es idempotente: si Flow notifica dos veces,
-- la segunda llamada devuelve los números ya asignados sin duplicar.
create or replace function public.asignar_numeros(p_orden_id uuid)
returns integer[]
language plpgsql security definer
set search_path = public
as $$
declare
  v_orden ordenes%rowtype;
  v_sorteo sorteos%rowtype;
  v_ocupados integer;
  v_numeros integer[];
begin
  select * into v_orden from ordenes where id = p_orden_id for update;
  if not found then
    raise exception 'La orden % no existe', p_orden_id;
  end if;
  if v_orden.estado <> 'pagada' then
    raise exception 'La orden % no está pagada (estado: %)', p_orden_id, v_orden.estado;
  end if;

  select array_agg(numero order by numero) into v_numeros
  from numeros where orden_id = p_orden_id;
  if v_numeros is not null then
    return v_numeros;  -- ya asignados (notificación repetida de Flow)
  end if;

  select * into v_sorteo from sorteos where id = v_orden.sorteo_id for update;

  select count(*) into v_ocupados from numeros where sorteo_id = v_sorteo.id;

  -- Ampliar el rango si los libres no alcanzan para esta compra
  -- o si queda menos del 20% disponible
  while (v_sorteo.rango_actual - v_ocupados) < greatest(v_orden.cantidad, ceil(v_sorteo.rango_actual * 0.2)::integer) loop
    v_sorteo.rango_actual := v_sorteo.rango_actual + v_sorteo.rango_minimo;
  end loop;

  update sorteos set rango_actual = v_sorteo.rango_actual where id = v_sorteo.id;

  -- Elegir números libres al azar dentro del rango
  select array_agg(n) into v_numeros
  from (
    select n
    from generate_series(1, v_sorteo.rango_actual) as n
    where not exists (
      select 1 from numeros x where x.sorteo_id = v_sorteo.id and x.numero = n
    )
    order by random()
    limit v_orden.cantidad
  ) libres;

  insert into numeros (sorteo_id, numero, user_id, orden_id)
  select v_sorteo.id, unnest(v_numeros), v_orden.user_id, p_orden_id;

  return v_numeros;
end;
$$;

-- Solo el backend (service role) puede asignar números
revoke execute on function public.asignar_numeros(uuid) from public, anon, authenticated;

-- ============ SORTEAR GANADOR ============
-- La ejecuta el admin desde el panel. Elige un número pagado al azar,
-- lo registra en el sorteo y devuelve los datos del ganador.
create or replace function public.sortear_ganador(p_sorteo uuid)
returns table (numero integer, email text, nombre text)
language plpgsql security definer
set search_path = public
as $$
declare
  v_numero numeros%rowtype;
begin
  if not public.es_admin() then
    raise exception 'Solo un administrador puede sortear';
  end if;

  select n.* into v_numero
  from numeros n
  where n.sorteo_id = p_sorteo
  order by random()
  limit 1;

  if not found then
    raise exception 'El sorteo no tiene números asignados todavía';
  end if;

  update sorteos
  set numero_ganador = v_numero.numero,
      estado = 'sorteado',
      fecha_sorteo = now()
  where id = p_sorteo;

  return query
  select v_numero.numero, p.email, p.nombre
  from perfiles p
  where p.id = v_numero.user_id;
end;
$$;

grant execute on function public.sortear_ganador(uuid) to authenticated;

-- ============================================================
-- DESPUÉS DE EJECUTAR ESTE SCRIPT:
-- 1. Regístrate en la web con tu correo.
-- 2. Conviértete en admin ejecutando aquí:
--    update public.perfiles set es_admin = true where email = 'tu@correo.cl';
-- ============================================================
