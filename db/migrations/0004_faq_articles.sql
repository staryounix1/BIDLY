-- 0004_faq_articles.sql
-- The support module exposes a public help centre (`GET /support/faq`) that
-- reads `faq_articles`. The table was referenced by the route but never
-- created, so the endpoint 500'd once it was registered. Additive only.

create table if not exists faq_articles (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  locale       varchar(5) not null default 'en',
  category     text not null default 'GENERAL',
  question     text not null,
  answer       text not null,
  sort_order   integer not null default 0,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_faq_articles_pub on faq_articles(is_published, locale, category, sort_order);

insert into faq_articles (slug, locale, category, question, answer, sort_order) values
  ('how-to-create-request', 'en', 'REQUESTS', 'How do I create a service request?',
   'Open the Requests page, choose a category and service, describe what you need, set a budget and a pickup location, then publish. Providers nearby will start sending offers.', 10),
  ('how-offers-work', 'en', 'OFFERS', 'How do offers work?',
   'Once your request is published, matched providers send offers with their price and a short message. Compare them and accept the one you prefer; the others are declined automatically.', 20),
  ('how-payments-work', 'en', 'PAYMENTS', 'How and when do I pay?',
   'Payment is made from your wallet once the job is marked complete. Funds are held securely and released to the provider minus the platform commission.', 30),
  ('how-disputes-work', 'en', 'SAFETY', 'What if something goes wrong?',
   'You can open a dispute from a completed or in-progress job. Support reviews the case, can request evidence from both sides, and may issue a refund.', 40),
  ('how-to-become-provider', 'en', 'ACCOUNT', 'How do I become a provider?',
   'Register as a provider, complete your profile, add the services you offer and upload your verification documents. Once an admin verifies your account you can send offers.', 50)
on conflict (slug) do nothing;
