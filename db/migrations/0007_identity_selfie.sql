-- =====================================================================
-- 0007 — identity selfie
--
-- Front and back of an ID prove the document is real; they do not prove the
-- person holding the account is the person on it. A selfie closes that gap:
-- the reviewer compares the face against the photo on the document.
--
-- Kept in its own column rather than folded into the JSON payload so the admin
-- queue can select it without parsing payloads, and so a future automated face
-- match has a stable field to read.
-- =====================================================================

begin;

alter table users
  add column if not exists identity_selfie_url text;

-- Existing pending reviews were submitted without a selfie. They stay valid
-- (the reviewer sees the absence), so the column is nullable and no review is
-- invalidated retroactively.

commit;
