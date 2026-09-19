-- =====================================================================
-- PART 2 migration — behavioural verification
--
-- Proves that the structures added by 0002 actually enforce what they
-- claim: the review eligibility guard, the new sub-rating constraints,
-- the generic attachment store, and the request location-precision rule.
--
-- Every block expects the guarded operation to FAIL; if it succeeds the
-- invariant is broken and this script raises. The whole thing runs in a
-- transaction that is rolled back, so it leaves no data behind.
--
-- Run: node scripts/test-db.mjs   (or: pnpm db:test)
-- =====================================================================

begin;

do $$
declare
  v_customer uuid;
  v_provider uuid;
  v_request  uuid;
  v_job      uuid;
  v_offer    uuid;
begin
  -- ---------------------------------------------------------------
  -- fixtures
  -- ---------------------------------------------------------------
  insert into currencies(code,name,symbol,minor_units)
  values ('MAD','Moroccan Dirham','DH',2) on conflict (code) do nothing;

  insert into countries(code,name_en,default_currency,default_locale,timezone,dial_code,is_launch_market)
  values ('MA','Morocco','MAD','ar','Africa/Casablanca','+212',true) on conflict (code) do nothing;

  insert into cities(country_code,name_en,name_ar,slug,lat,lng,timezone,is_launch)
  values ('MA','Rabat','الرباط','p2-rabat',34.0209,-6.8416,'Africa/Casablanca',true)
  on conflict (slug) do nothing;

  insert into categories(slug,name_en,name_ar)
  values ('p2-cat','P2 Cat','تصنيف') on conflict (slug) do nothing;

  insert into subcategories(category_id,slug,name_en,name_ar)
  select id,'p2-sub','P2 Sub','فرعي' from categories where slug='p2-cat'
  on conflict (slug) do nothing;

  insert into services(subcategory_id,slug,name_en,name_ar,default_currency)
  select id,'p2-svc','P2 Svc','خدمة','MAD' from subcategories where slug='p2-sub'
  on conflict (slug) do nothing;

  insert into users(email,phone,password_hash,role,status)
  values ('p2c@inv.test','+212600000201','x','CUSTOMER','ACTIVE'),
         ('p2p@inv.test','+212600000202','x','PROVIDER','ACTIVE')
  on conflict do nothing;

  select id into v_customer from users where email='p2c@inv.test';
  select id into v_provider from providers where user_id=(select id from users where email='p2p@inv.test');

  if v_provider is null then
    insert into providers(user_id,display_name,status,verification_status,city_id)
    select u.id,'P2 Inv Provider','ACTIVE','VERIFIED',c.id
    from users u, cities c
    where u.email='p2p@inv.test' and c.slug='p2-rabat'
    returning id into v_provider;
  end if;

  insert into requests(code,customer_id,category_id,subcategory_id,service_id,title,status,currency,city_id)
  select 'REQ-P2-INV',v_customer,c.id,sc.id,s.id,'P2 invariant','PUBLISHED','MAD',ci.id
  from categories c, subcategories sc, services s, cities ci
  where c.slug='p2-cat' and sc.slug='p2-sub' and s.slug='p2-svc' and ci.slug='p2-rabat'
  on conflict (code) do nothing
  returning id into v_request;

  insert into offers(request_id,provider_id,price_minor,currency,status)
  values (v_request,v_provider,5000,'MAD','ACCEPTED')
  returning id into v_offer;

  -- Start the job in IN_PROGRESS: it is a legal predecessor of COMPLETED,
  -- so CHECK 2 can step it forward through the real transition trigger,
  -- while CHECK 1 still has a job that the review guard must reject.
  insert into jobs(code,request_id,customer_id,provider_id,accepted_offer_id,service_id,
                  final_price_minor,currency,status)
  select 'JOB-P2-INV',v_request,v_customer,v_provider,v_offer,
         (select service_id from requests where id=v_request),
         5000,'MAD','IN_PROGRESS'
  returning id into v_job;

  -- ---------------------------------------------------------------
  -- CHECK 1: a review is rejected while the job is not completed
  -- ---------------------------------------------------------------
  begin
    insert into reviews(job_id, author_id, subject_id, direction, rating)
    values (v_job, v_customer, (select user_id from providers where id=v_provider),
            'CUSTOMER', 5);
    raise exception 'FAILED 1: a review was accepted for a job in IN_PROGRESS state';
  exception when check_violation then
    raise notice 'PASS 1: review blocked for a job that is not completed';
  end;

  -- ---------------------------------------------------------------
  -- CHECK 2: once completed, the review is accepted
  -- ---------------------------------------------------------------
  update jobs set status='COMPLETED' where id=v_job;

  begin
    insert into reviews(job_id, author_id, subject_id, direction, rating,
                        rating_punctuality, rating_quality, rating_communication, rating_value)
    values (v_job, v_customer, (select user_id from providers where id=v_provider),
            'CUSTOMER', 5, 4, 5, 4, 5);
    raise notice 'PASS 2: review accepted after the job completed';
  exception when others then
    raise exception 'FAILED 2: a valid review was rejected: %', sqlerrm;
  end;

  -- ---------------------------------------------------------------
  -- CHECK 3: a duplicate review for the same job + direction is rejected
  -- ---------------------------------------------------------------
  begin
    insert into reviews(job_id, author_id, subject_id, direction, rating)
    values (v_job, v_customer, (select user_id from providers where id=v_provider),
            'CUSTOMER', 3);
    raise exception 'FAILED 3: a duplicate review was accepted';
  exception when unique_violation then
    raise notice 'PASS 3: duplicate review for the same job and direction blocked';
  end;

  -- ---------------------------------------------------------------
  -- CHECK 4: sub-rating outside 1-5 is rejected
  -- ---------------------------------------------------------------
  begin
    insert into reviews(job_id, author_id, subject_id, direction, rating, rating_quality)
    values (v_job, (select user_id from providers where id=v_provider), v_customer,
            'PROVIDER', 4, 9);
    raise exception 'FAILED 4: an out-of-range sub-rating was accepted';
  exception when check_violation then
    raise notice 'PASS 4: sub-rating outside 1-5 rejected';
  end;

  -- ---------------------------------------------------------------
  -- CHECK 5: attachments store metadata and reject negative sizes
  -- ---------------------------------------------------------------
  begin
    insert into attachments(owner_type, owner_id, uploader_id, storage_key, size_bytes)
    values ('REQUEST', v_request, v_customer, 'requests/x.jpg', -1);
    raise exception 'FAILED 5: a negative attachment size was accepted';
  exception when check_violation then
    raise notice 'PASS 5: negative attachment size rejected';
  end;

  insert into attachments(owner_type, owner_id, uploader_id, storage_key, mime_type, size_bytes)
  values ('REQUEST', v_request, v_customer, 'requests/ok.jpg', 'image/jpeg', 2048);

  raise notice 'PASS 6: attachment metadata stored without binary content';

  -- ---------------------------------------------------------------
  -- CHECK 7: location precision cannot be EXACT without coordinates
  -- ---------------------------------------------------------------
  begin
    update requests set location_precision='EXACT' where id=v_request;
    raise exception 'FAILED 7: EXACT precision accepted with no coordinates';
  exception when check_violation then
    raise notice 'PASS 7: EXACT precision requires coordinates';
  end;

  -- ---------------------------------------------------------------
  -- CHECK 8: coordinates present -> EXACT precision is allowed
  -- (status is left untouched so the request-transition trigger does
  --  not fire; this checks the location-precision rule in isolation)
  -- ---------------------------------------------------------------
  update requests
     set pickup_lat=34.0209, pickup_lng=-6.8416,
         approx_lat=34.02, approx_lng=-6.84,
         location_precision='EXACT'
   where id=v_request;

  raise notice 'PASS 8: EXACT precision accepted once coordinates are set';

  -- ---------------------------------------------------------------
  -- CHECK 9: approximate point must stay within valid lat/lng ranges
  -- ---------------------------------------------------------------
  begin
    update requests set approx_lat = 200 where id=v_request;
    raise exception 'FAILED 9: an out-of-range approximate latitude was accepted';
  exception when check_violation then
    raise notice 'PASS 9: out-of-range approximate latitude rejected';
  end;

  raise notice 'ALL PART 2 MIGRATION CHECKS PASSED';
end $$;

rollback;
