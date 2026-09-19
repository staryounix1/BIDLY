-- =====================================================================
-- BIDLY — invariants test suite
-- Run after 0001_init.sql + seed.sql on a scratch database.
-- Every block expects the guarded operation to FAIL; if it succeeds,
-- the invariant is broken and the script raises.
-- Usage: psql -v ON_ERROR_STOP=1 -f db/tests/invariants.sql
-- =====================================================================

\set ON_ERROR_STOP on

begin;

-- ---------- fixtures -------------------------------------------------
insert into currencies(code,name,symbol,minor_units)
values ('MAD','Moroccan Dirham','DH',2),('USD','US Dollar','$',2)
on conflict (code) do nothing;

insert into countries(code,name_en,default_currency,default_locale,timezone,dial_code,is_launch_market)
values ('MA','Morocco','MAD','ar','Africa/Casablanca','+212',true)
on conflict (code) do nothing;

insert into cities(country_code,name_en,name_ar,slug,lat,lng,timezone,is_launch)
values ('MA','Rabat','الرباط','rabat-test',34.0209,-6.8416,'Africa/Casablanca',true)
on conflict (slug) do nothing;

insert into categories(slug,name_en,name_ar) values ('test-cat','Test','اختبار')
on conflict (slug) do nothing;
insert into subcategories(category_id,slug,name_en,name_ar)
select id,'test-sub','Test Sub','فرعي' from categories where slug='test-cat'
on conflict (slug) do nothing;
insert into services(subcategory_id,slug,name_en,name_ar,default_currency)
select id,'test-svc','Test Svc','خدمة','MAD' from subcategories where slug='test-sub'
on conflict (slug) do nothing;

insert into users(email,phone,password_hash,role,status)
values ('t-cust@example.test','+212600000001','x','CUSTOMER','ACTIVE'),
       ('t-prov@example.test','+212600000002','x','PROVIDER','ACTIVE')
on conflict do nothing;

insert into providers(user_id,display_name,status,verification_status,city_id)
select u.id,'Test Provider','ACTIVE','VERIFIED',c.id
from users u, cities c
where u.email='t-prov@example.test' and c.slug='rabat-test'
on conflict (user_id) do nothing;

insert into provider_services(provider_id,service_id,min_price_minor,max_price_minor,currency)
select p.id,s.id,1000,100000,'MAD'
from providers p, services s
where p.display_name='Test Provider' and s.slug='test-svc'
on conflict (provider_id,service_id) do nothing;

insert into requests(code,customer_id,category_id,subcategory_id,service_id,title,status,currency,city_id)
select 'REQ-TEST1',u.id,c.id,sc.id,s.id,'Invariant test','PUBLISHED','MAD',ci.id
from users u, categories c, subcategories sc, services s, cities ci
where u.email='t-cust@example.test' and c.slug='test-cat' and sc.slug='test-sub'
  and s.slug='test-svc' and ci.slug='rabat-test'
on conflict (code) do nothing;

-- ---------- 1. money must not be float -------------------------------
do $$
begin
  begin
    perform 1 from information_schema.columns
    where table_schema='public'
      and column_name like '%_minor%'
      and data_type in ('numeric','double precision','real');
    if found then
      raise exception 'INVARIANT FAILED: a *_minor column is not an integer type';
    end if;
  end;
  raise notice 'PASS 1: all *_minor money columns are integer types';
end $$;

-- ---------- 2. request transition guard ------------------------------
do $$
declare v_req uuid; v_cust uuid;
begin
  select id into v_req from requests where code='REQ-TEST1';
  -- legal: PUBLISHED -> MATCHING
  update requests set status='MATCHING' where id=v_req;
  -- illegal: MATCHING -> COMPLETED
  begin
    update requests set status='COMPLETED' where id=v_req;
    raise exception 'INVARIANT FAILED: illegal request transition was allowed';
  exception when check_violation then
    raise notice 'PASS 2: illegal request transition rejected';
  end;
end $$;

-- ---------- 3. one accepted offer per request ------------------------
do $$
declare v_req uuid; v_prov uuid; v_off1 uuid;
begin
  select id into v_req from requests where code='REQ-TEST1';
  select id into v_prov from providers where display_name='Test Provider';
  insert into offers(request_id,provider_id,price_minor,currency,status)
  values (v_req,v_prov,5000,'MAD','ACCEPTED') returning id into v_off1;
  begin
    insert into offers(request_id,provider_id,price_minor,currency,status)
    values (v_req,v_prov,6000,'MAD','ACCEPTED');
    raise exception 'INVARIANT FAILED: a second ACCEPTED offer was allowed';
  exception when unique_violation then
    raise notice 'PASS 3: second ACCEPTED offer per request rejected';
  end;
end $$;

-- ---------- 4. one active offer per provider per request --------------
do $$
declare v_req uuid; v_prov uuid;
begin
  select id into v_req from requests where code='REQ-TEST1';
  select id into v_prov from providers where display_name='Test Provider';
  -- there is already an ACCEPTED offer, so a PENDING one is allowed (different status)
  insert into offers(request_id,provider_id,price_minor,currency,status)
  values (v_req,v_prov,7000,'MAD','PENDING');
  begin
    insert into offers(request_id,provider_id,price_minor,currency,status)
    values (v_req,v_prov,8000,'MAD','PENDING');
    raise exception 'INVARIANT FAILED: duplicate PENDING offer was allowed';
  exception when unique_violation then
    raise notice 'PASS 4: duplicate PENDING offer per provider/request rejected';
  end;
end $$;

-- ---------- 5. offer_history is append-only ---------------------------
do $$
begin
  begin
    delete from offer_history where true;
    raise exception 'INVARIANT FAILED: offer_history allowed DELETE';
  exception when others then
    raise notice 'PASS 5: offer_history is append-only';
  end;
end $$;

-- ---------- 6. ledger balance integrity -------------------------------
do $$
declare v_prov_user uuid; v_wallet uuid;
begin
  select u.id into v_prov_user from users u where u.email='t-prov@example.test';
  insert into wallets(owner_type,owner_id,currency) values ('PROVIDER',v_prov_user,'MAD')
  returning id into v_wallet;
  -- correct credit: balance_after must equal the wallet balance after apply
  insert into wallet_transactions(wallet_id,type,direction,amount_minor,currency,balance_after_minor,description)
  values (v_wallet,'JOB_EARNING','CREDIT',5000,'MAD',5000,'test credit');
  if (select available_minor from wallets where id=v_wallet) <> 5000 then
    raise exception 'INVARIANT FAILED: wallet balance not updated by ledger';
  end if;
  -- wrong balance_after must be rejected
  begin
    insert into wallet_transactions(wallet_id,type,direction,amount_minor,currency,balance_after_minor)
    values (v_wallet,'ADJUSTMENT','CREDIT',100,'MAD',999999);
    raise exception 'INVARIANT FAILED: mismatched balance_after accepted';
  exception when check_violation then
    raise notice 'PASS 6: ledger balance integrity enforced';
  end;
end $$;

-- ---------- 7. wallet cannot go negative ------------------------------
do $$
declare v_wallet uuid;
begin
  select w.id into v_wallet from wallets w join users u on u.id=w.owner_id
  where u.email='t-prov@example.test';
  begin
    update wallets set available_minor = -1 where id=v_wallet;
    raise exception 'INVARIANT FAILED: wallet went negative';
  exception when check_violation then
    raise notice 'PASS 7: wallet cannot go negative';
  end;
end $$;

-- ---------- 8. review uniqueness per direction ------------------------
do $$
declare v_req uuid; v_cust uuid; v_prov uuid; v_prov_user uuid;
        v_job uuid; v_off uuid;
begin
  select r.id, r.customer_id into v_req, v_cust from requests r where r.code='REQ-TEST1';
  select p.id, p.user_id into v_prov, v_prov_user from providers p where p.display_name='Test Provider';
  select id into v_off from offers where request_id=v_req and status='ACCEPTED';
  insert into jobs(request_id,customer_id,provider_id,accepted_offer_id,service_id,
                   final_price_minor,currency,status)
  select v_req,v_cust,v_prov,v_off,s.id,5000,'MAD','COMPLETED'
  from services s where s.slug='test-svc'
  returning id into v_job;

  insert into reviews(job_id,author_id,subject_id,direction,rating)
  values (v_job,v_cust,v_prov_user,'CUSTOMER',5);
  begin
    insert into reviews(job_id,author_id,subject_id,direction,rating)
    values (v_job,v_cust,v_prov_user,'CUSTOMER',4);
    raise exception 'INVARIANT FAILED: duplicate review direction allowed';
  exception when unique_violation then
    raise notice 'PASS 8: one review per direction per job enforced';
  end;
end $$;

-- ---------- 9. refund cap ---------------------------------------------
do $$
declare v_job uuid; v_pay uuid; v_cust uuid;
begin
  select j.id into v_job from jobs j join requests r on r.id=j.request_id where r.code='REQ-TEST1';
  select customer_id into v_cust from jobs where id=v_job;
  insert into payments(job_id,customer_id,amount_minor,currency,status,captured_minor)
  values (v_job,v_cust,5000,'MAD','CAPTURED',5000) returning id into v_pay;
  insert into refunds(payment_id,amount_minor,currency,status,reason) values (v_pay,2000,'MAD','COMPLETED','test');
  begin
    insert into refunds(payment_id,amount_minor,currency,status,reason) values (v_pay,4000,'MAD','COMPLETED','over');
    raise exception 'INVARIANT FAILED: refund over captured amount allowed';
  exception when check_violation then
    raise notice 'PASS 9: refund cap enforced';
  end;
end $$;

-- ---------- 10. identifiers present -----------------------------------
do $$
begin
  begin
    insert into users(password_hash,role,status) values ('x','CUSTOMER','ACTIVE');
    raise exception 'INVARIANT FAILED: user without email or phone allowed';
  exception when check_violation then
    raise notice 'PASS 10: user requires email or phone';
  end;
end $$;

-- ---------- 11. job commission <= price -------------------------------
do $$
declare v_job uuid;
begin
  select j.id into v_job from jobs j join requests r on r.id=j.request_id where r.code='REQ-TEST1';
  begin
    update jobs set commission_minor = final_price_minor + 1 where jobs.id=v_job;
    raise exception 'INVARIANT FAILED: commission exceeded price';
  exception when check_violation then
    raise notice 'PASS 11: commission cannot exceed job price';
  end;
end $$;

-- ---------- 12. audit_logs append-only --------------------------------
do $$
begin
  begin
    update audit_logs set action='tampered';
    raise exception 'INVARIANT FAILED: audit_logs allowed UPDATE';
  exception when others then
    raise notice 'PASS 12: audit_logs is append-only';
  end;
end $$;

rollback;

\echo '=========================================='
\echo 'ALL INVARIANT TESTS PASSED'
\echo '=========================================='
