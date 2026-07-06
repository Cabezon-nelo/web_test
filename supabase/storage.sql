-- ============================================================
-- Storage para las imágenes de los sorteos
-- Ejecutar UNA VEZ en el editor SQL de Supabase (SQL Editor > New query)
-- ============================================================

-- Bucket público: las imágenes se sirven por URL directa
insert into storage.buckets (id, name, public)
values ('imagenes', 'imagenes', true)
on conflict (id) do nothing;

-- Solo un administrador puede subir o reemplazar imágenes
create policy "admin sube imagenes" on storage.objects
  for insert with check (bucket_id = 'imagenes' and public.es_admin());

create policy "admin actualiza imagenes" on storage.objects
  for update using (bucket_id = 'imagenes' and public.es_admin());

create policy "admin elimina imagenes" on storage.objects
  for delete using (bucket_id = 'imagenes' and public.es_admin());

-- Cualquiera puede ver las imágenes (el sitio es público)
create policy "lectura publica de imagenes" on storage.objects
  for select using (bucket_id = 'imagenes');
