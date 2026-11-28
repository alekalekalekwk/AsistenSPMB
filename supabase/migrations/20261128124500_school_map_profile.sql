-- Migrasi: Kolom Lokasi & Profil Publik Sekolah untuk Peta Interaktif Nusantara Sigi.
-- Aman dijalankan berulang kali (idempotent) di Supabase SQL Editor.

alter table public.schools
  add column if not exists level text not null default '',
  add column if not exists province text not null default '',
  add column if not exists city text not null default '',
  add column if not exists address text not null default '',
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists npsn text not null default '',
  add column if not exists accreditation text not null default '',
  add column if not exists website text not null default '',
  add column if not exists description text not null default '',
  add column if not exists show_on_map boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'schools_latitude_indonesia_chk'
  ) then
    alter table public.schools
      add constraint schools_latitude_indonesia_chk
      check (latitude is null or (latitude between -12 and 7));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'schools_longitude_indonesia_chk'
  ) then
    alter table public.schools
      add constraint schools_longitude_indonesia_chk
      check (longitude is null or (longitude between 94 and 142));
  end if;
end $$;

create index if not exists idx_schools_public_map
  on public.schools (created_at asc)
  where show_on_map = true and latitude is not null and longitude is not null;

-- Backfill profil & lokasi resmi SMK Wikrama Bogor (sekolah pertama Sigi).
update public.schools
set
  level = case when coalesce(level, '') = '' then 'SMK' else level end,
  province = case when coalesce(province, '') = '' then 'Jawa Barat' else province end,
  city = case when coalesce(city, '') = '' then 'Kota Bogor' else city end,
  address = case when coalesce(address, '') = '' then 'Jl. Raya Wangun No. 21, Kel. Sindangsari, Kec. Bogor Timur, Kota Bogor, Jawa Barat' else address end,
  latitude = coalesce(latitude, -6.5971),
  longitude = coalesce(longitude, 106.8060),
  npsn = case when coalesce(npsn, '') = '' then '20220299' else npsn end,
  accreditation = case when coalesce(accreditation, '') = '' then 'A' else accreditation end,
  website = case when coalesce(website, '') = '' then 'https://smkwikrama.sch.id' else website end,
  description = case when coalesce(description, '') = '' then 'SMK Pusat Keunggulan di bawah Yayasan Wikrama Indonesia dengan 7 jurusan di bidang Teknologi Informasi, Bisnis Manajemen, dan Pariwisata.' else description end,
  show_on_map = true
where slug = 'wikrama';
