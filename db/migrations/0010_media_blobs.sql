-- =====================================================================
-- Request media payloads.
--
-- Photos are small enough to travel as data URLs inside the request body,
-- but a video is not: the API parses JSON with a 1 MB cap, so a clip could
-- never be attached that way. A file that the customer actually uploads is
-- therefore stored here as bytes and served back by URL, which keeps the
-- request body small however large the file is.
--
-- This is deliberately the smallest thing that works: no object store, no
-- extra service, and `request_media.url` keeps pointing at something the
-- existing viewers can render. Swapping in real object storage later means
-- writing to a bucket here and storing the returned URL instead.
-- =====================================================================

begin;

create table if not exists media_blobs (
  id            uuid primary key default gen_random_uuid(),
  uploader_id   uuid not null references users(id) on delete cascade,
  mime_type     text not null,
  size_bytes    bigint not null check (size_bytes >= 0),
  bytes         bytea not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_media_blobs_uploader on media_blobs(uploader_id);

commit;
