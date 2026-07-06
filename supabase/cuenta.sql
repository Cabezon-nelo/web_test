-- ============================================================
-- Sección "Mi cuenta": permitir que cada usuario edite SU nombre
-- Ejecutar UNA VEZ en el editor SQL de Supabase (SQL Editor > New query)
--
-- Se hace con una función en vez de una política de UPDATE sobre
-- perfiles, para que el usuario solo pueda cambiar su nombre y
-- jamás sus campos protegidos (es_admin, bloqueado).
-- ============================================================

create or replace function public.actualizar_nombre(p_nombre text)
returns void
language sql security definer
set search_path = public
as $$
  update perfiles set nombre = p_nombre where id = auth.uid();
$$;

grant execute on function public.actualizar_nombre(text) to authenticated;
