-- =====================================================================
-- BIDLY — seed.sql
-- Idempotent development seed: reference/config data + fake dev users.
-- Safe to run repeatedly. NEVER contains real personal information.
-- Dev passwords are documented in README and are DEV-ONLY.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- Currencies (MAD is the launch currency; USD/EUR prove multi-currency)
-- ---------------------------------------------------------------------
insert into currencies(code,name,symbol,minor_units,is_active) values
  ('MAD','Moroccan Dirham','DH',2,true),
  ('USD','US Dollar','$',2,true),
  ('EUR','Euro','€',2,true)
on conflict (code) do update set name=excluded.name, symbol=excluded.symbol, minor_units=excluded.minor_units;

-- ---------------------------------------------------------------------
-- Countries & launch market (MA). Country config is data, not code.
-- ---------------------------------------------------------------------
insert into countries(code,name_en,name_fr,name_ar,default_currency,default_locale,timezone,dial_code,is_launch_market,is_active)
values ('MA','Morocco','Maroc','المغرب','MAD','ar','Africa/Casablanca','+212',true,true)
on conflict (code) do update set name_en=excluded.name_en, name_fr=excluded.name_fr, name_ar=excluded.name_ar;

insert into cities(country_code,name_en,name_fr,name_ar,slug,lat,lng,timezone,is_launch,is_active) values
  ('MA','Rabat','Rabat','الرباط','rabat',34.020882,-6.841650,'Africa/Casablanca',true,true),
  ('MA','Salé','Salé','سلا',       'sale', 34.053100,-6.798460,'Africa/Casablanca',true,true),
  ('MA','Témara','Témara','تمارة',  'temara',33.928660,-6.906560,'Africa/Casablanca',true,true)
on conflict (slug) do update set name_en=excluded.name_en, is_launch=excluded.is_launch;

-- Service areas (radius coverage per launch city)
insert into service_areas(city_id,name,kind,center_lat,center_lng,radius_km)
select c.id, c.name_en || ' — 20 km', 'RADIUS', c.lat, c.lng, 20
from cities c where c.slug in ('rabat','sale','temara')
  and not exists (select 1 from service_areas sa where sa.city_id=c.id);

-- ---------------------------------------------------------------------
-- Category tree (spec §7). All display names are data.
-- ---------------------------------------------------------------------
insert into categories(slug,name_en,name_fr,name_ar,icon,sort_order) values
  ('home-services','Home Services','Services à domicile','خدمات منزلية','home',1),
  ('moving-delivery','Moving & Local Delivery','Déménagement & Livraison','نقل وتوصيل محلي','truck',2),
  ('personal-tasks','Personal Tasks','Tâches personnelles','مهام شخصية','checklist',3)
on conflict (slug) do update set name_en=excluded.name_en, name_fr=excluded.name_fr, name_ar=excluded.name_ar, icon=excluded.icon;

-- Subcategories
insert into subcategories(category_id,slug,name_en,name_fr,name_ar,sort_order)
select c.id, v.slug, v.en, v.fr, v.ar, v.so
from (values
  ('home-services','plumbing','Plumbing','Plomberie','سباكة',1),
  ('home-services','electrical','Electrical','Électricité','كهرباء',3),
  ('home-services','plasterer','Plasterer','Plâtrerie','جباص',4),
  ('home-services','mason','Mason / Tiler','Maçonnerie / Carrelage','طريسيان',5),
  ('home-services','tiler','Tiler','Carrelage','زليج',6),
  ('home-services','tailor','Tailor','Couture','خياط',7),
  ('home-services','handyman','Handyman','Bricolage','أشغال يدوية',8),
  ('home-services','appliance-repair','Appliance Repair','Réparation d''électroménager','إصلاح الأجهزة',9),
  ('home-services','painting','Painting','Peinture','صباغ',10),
  ('home-services','cleaning','Cleaning','Nettoyage','تنظيف',11),
  ('moving-delivery','furniture-moving','Furniture Moving','Déménagement de meubles','نقل الأثاث',1),
  ('moving-delivery','small-moves','Small Moves','Petits déménagements','نقل صغير',2),
  ('moving-delivery','local-delivery','Local Delivery','Livraison locale','توصيل محلي',3),
  ('moving-delivery','pickup-dropoff','Pickup / Drop-off','Récupération / Dépôt','استلام وتسليم',4),
  ('moving-delivery','small-item-transport','Small Item Transport','Transport de petits objets','نقل أشياء صغيرة',5),
  ('personal-tasks','shopping-pickup','Shopping / Pickup','Courses / Récupération','تسوق واستلام',1),
  ('personal-tasks','package-collection','Package Collection','Collecte de colis','جمع الطرود',2),
  ('personal-tasks','local-errands','Local Errands','Courses locales','مشاوير محلية',3),
  ('personal-tasks','simple-assistance','Simple Assistance','Assistance simple','مساعدة بسيطة',4)
) as v(cat,slug,en,fr,ar,so)
join categories c on c.slug = v.cat
on conflict (slug) do update set name_en=excluded.name_en, name_fr=excluded.name_fr, name_ar=excluded.name_ar;

commit;

-- =====================================================================
-- Services (leaf offerable units). pricing_model drives UI + validation.
-- =====================================================================
begin;

insert into services(subcategory_id,slug,name_en,name_fr,name_ar,pricing_model,default_currency,
                     min_price_minor,max_price_minor,commission_bps,
                     requires_location,requires_destination,requires_schedule,duration_minutes,sort_order)
select sc.id, v.slug, v.en, v.fr, v.ar, v.pm::bidly_pricing_model, 'MAD',
       v.minp, v.maxp, v.cbps, v.rloc, v.rdst, v.rsch, v.dur, v.so
from (values
  -- Home Services
  ('plumbing','leak-repair','Leak Repair','Réparation de fuite','إصلاح تسرب',       'OFFER',   10000, 200000, 1500, true, false, true,  60, 1),
  ('plumbing','drain-unclogging','Drain Unclogging','Débouchage','تسليك البالوعات','OFFER',    8000, 150000, 1500, true, false, true,  45, 2),
  ('plumbing','water-heater-install','Water Heater Installation','Installation chauffe-eau','تركيب سخان','INSPECTION', null, null, 1500, true, false, true, 120, 3),
  ('plasterer','wall-plastering','Wall Plastering','Plâtrerie murale','جباص الجدران','OFFER', 15000, 200000, 1500, true, false, true, 180, 1),
  ('plasterer','ceiling-plastering','Ceiling Plastering','Plafonnage','جباص السقف','OFFER', 20000, 250000, 1500, true, false, true, 240, 2),
  ('plasterer','decorative-plaster','Decorative Plaster / Stucco','Plâtre décoratif','جباص مزخرف','INSPECTION', null, null, 1500, true, false, true, 300, 3),
  ('mason','wall-building','Wall Building','Construction de mur','بناء حيط','OFFER', 30000, 500000, 1500, true, false, true, 480, 1),
  ('mason','wall-demolition','Wall Demolition','Démolition de mur','هدم حيط','OFFER', 20000, 300000, 1500, true, false, true, 240, 2),
  ('mason','masonry-repair','Masonry Repair','Réparation de maçonnerie','إصلاح البناء','OFFER', 15000, 250000, 1500, true, false, true, 180, 3),
  ('tiler','floor-tiling','Floor Tiling','Carrelage de sol','تبليط الأرضية','OFFER', 15000, 250000, 1500, true, false, true, 300, 1),
  ('tiler','wall-tiling','Wall Tiling','Carrelage mural','تبليط الجدران','OFFER', 15000, 250000, 1500, true, false, true, 240, 2),
  ('tiler','tile-repair','Tile Repair / Replacement','Réparation de carrelage','إصلاح الزليج','OFFER', 8000, 150000, 1500, true, false, true, 120, 3),
  ('tailor','garment-alteration','Garment Alteration','Retouche de vêtement','تعديل لباس','OFFER', 3000, 60000, 1500, false, false, false, 60, 1),
  ('tailor','custom-garment','Custom Garment Sewing','Confection sur mesure','خياطة على المقاس','OFFER', 15000, 200000, 1500, false, false, false, 480, 2),
  ('tailor','curtain-sewing','Curtain / Upholstery Sewing','Couture de rideaux','خياطة الستائر','OFFER', 8000, 120000, 1500, false, false, false, 180, 3),
  ('electrical','outlet-repair','Outlet / Switch Repair','Réparation prise','إصلاح مأخذ', 'OFFER', 5000, 100000, 1500, true, false, true, 45, 1),
  ('electrical','lighting-install','Lighting Installation','Installation éclairage','تركيب إضاءة','OFFER',6000,120000,1500,true,false,true,60,2),
  ('electrical','electrical-panel','Electrical Panel Work','Tableau électrique','لوحة كهربائية','INSPECTION',null,null,1500,true,false,true,180,3),
  ('handyman','furniture-assembly','Furniture Assembly','Montage de meubles','تركيب الأثاث','FIXED_QUOTE',5000,80000,1200,true,false,true,90,1),
  ('handyman','wall-mounting','Wall Mounting / Shelves','Fixation murale','تثبيت على الحائط','OFFER',4000,60000,1200,true,false,true,45,2),
  ('handyman','general-repairs','General Repairs','Réparations générales','إصلاحات عامة','OFFER',5000,120000,1200,true,false,true,60,3),
  ('appliance-repair','washing-machine','Washing Machine Repair','Réparation lave-linge','إصلاح غسالة','INSPECTION',null,null,1500,true,false,true,90,1),
  ('appliance-repair','refrigerator','Refrigerator Repair','Réparation réfrigérateur','إصلاح ثلاجة','INSPECTION',null,null,1500,true,false,true,90,2),
  ('appliance-repair','oven-repair','Oven / Stove Repair','Réparation four','إصلاح فرن','INSPECTION',null,null,1500,true,false,true,90,3),
  ('painting','interior-room','Interior Room Painting','Peinture intérieure','طلاء داخلي','RANGE',30000,150000,1500,true,false,true,240,1),
  ('painting','apartment-painting','Apartment Painting','Peinture appartement','طلاء شقة','RANGE',150000,800000,1500,true,false,true,720,2),
  ('cleaning','standard-cleaning','Standard Home Cleaning','Nettoyage standard','تنظيف عادي','RANGE',15000,60000,1800,true,false,true,120,1),
  ('cleaning','deep-cleaning','Deep Cleaning','Nettoyage en profondeur','تنظيف عميق','RANGE',40000,150000,1800,true,false,true,300,2),
  ('cleaning','post-construction','Post-Construction Cleaning','Nettoyage après travaux','تنظيف بعد البناء','INSPECTION',null,null,1800,true,false,true,480,3),
  -- Moving & Local Delivery
  ('furniture-moving','apartment-move','Apartment Move','Déménagement appartement','نقل شقة','RANGE',30000,300000,1500,true,true,true,240,1),
  ('furniture-moving','single-item-move','Single Item Move','Déménagement d''un objet','نقل قطعة واحدة','OFFER',10000,120000,1500,true,true,true,90,2),
  ('small-moves','studio-move','Studio Move','Déménagement studio','نقل استوديو','RANGE',20000,180000,1500,true,true,true,180,1),
  ('local-delivery','standard-delivery','Standard Local Delivery','Livraison locale standard','توصيل محلي','RANGE',1500,15000,1500,true,true,true,60,1),
  ('local-delivery','express-delivery','Express Delivery','Livraison express','توصيل سريع','RANGE',3000,30000,1500,true,true,false,30,2),
  ('pickup-dropoff','store-pickup','Store Pickup','Récupération en magasin','استلام من متجر','RANGE',1500,15000,1500,true,true,true,60,1),
  ('pickup-dropoff','document-dropoff','Document Drop-off','Dépôt de documents','تسليم وثائق','FIXED_QUOTE',1500,8000,1500,true,true,false,30,2),
  ('small-item-transport','package-transport','Package Transport','Transport de colis','نقل طرد','RANGE',2000,20000,1500,true,true,true,60,1),
  ('small-item-transport','fragile-transport','Fragile Item Transport','Transport fragile','نقل هش','OFFER',4000,50000,1500,true,true,true,60,2),
  -- Personal Tasks
  ('shopping-pickup','grocery-shopping','Grocery Shopping','Courses alimentaires','تسوق البقالة','RANGE',3000,30000,1800,true,true,true,90,1),
  ('shopping-pickup','pharmacy-pickup','Pharmacy Pickup','Récupération pharmacie','استلام من صيدلية','FIXED_QUOTE',2000,12000,1800,true,true,false,45,2),
  ('package-collection','post-office-collect','Post Office Collection','Collecte à la poste','جمع من البريد','FIXED_QUOTE',2000,10000,1800,true,true,false,45,1),
  ('package-collection','courier-collect','Courier Collection','Collecte courrier','جمع من شركة الشحن','FIXED_QUOTE',2500,12000,1800,true,true,false,45,2),
  ('local-errands','errand-1h','Errand Run (up to 1h)','Courses (1h)','مشوار ساعة','HOURLY',6000,20000,1800,true,false,false,60,1),
  ('local-errands','queue-waiting','Queue / Waiting Service','File d''attente','الانتظار في طابور','HOURLY',5000,15000,1800,true,false,false,60,2),
  ('simple-assistance','elder-help','Assistance for Elderly','Assistance personnes âgées','مساعدة كبار السن','HOURLY',6000,25000,1800,true,false,true,60,1),
  ('simple-assistance','carry-help','Carry / Lift Assistance','Aide au portage','مساعدة في الحمل','FIXED_QUOTE',3000,15000,1800,true,false,false,30,2)
) as v(sub,slug,en,fr,ar,pm,minp,maxp,cbps,rloc,rdst,rsch,dur,so)
join subcategories sc on sc.slug = v.sub
on conflict (slug) do update set
  name_en=excluded.name_en, name_fr=excluded.name_fr, name_ar=excluded.name_ar,
  pricing_model=excluded.pricing_model, min_price_minor=excluded.min_price_minor,
  max_price_minor=excluded.max_price_minor, commission_bps=excluded.commission_bps,
  requires_destination=excluded.requires_destination, is_active=true;

commit;

-- =====================================================================
-- Dynamic service fields (spec §11). Fields are DATA, not frontend code.
-- Common fields are attached per service; travel services also get
-- pickup/destination detail questions.
-- =====================================================================
begin;

-- Helper: insert a field for every service, once.
create or replace function seed_common_fields() returns void language plpgsql as $$
declare s record;
begin
  for s in select id, requires_destination from services where is_active loop
    insert into service_fields(service_id,key,label_en,label_fr,label_ar,type,is_required,sort_order,validation)
    values
      (s.id,'details','What needs to be done?','Que faut-il faire ?','ما الذي يجب فعله؟','TEXTAREA',true,1,
        '{"minLength":10,"maxLength":1000}'::jsonb),
      (s.id,'urgency','How urgent is it?','Quelle est l''urgence ?','ما مدى الاستعجال؟','SELECT',true,2,'{}'::jsonb),
      (s.id,'photos','Photos','Photos','صور','PHOTO',false,3,'{"maxFiles":5}'::jsonb),
      (s.id,'address','Address','Adresse','العنوان','ADDRESS',true,4,'{}'::jsonb),
      (s.id,'preferred_time','Preferred time','Heure souhaitée','الوقت المفضل','DATETIME',false,5,'{}'::jsonb),
      (s.id,'budget_hint','Budget (optional)','Budget (optionnel)','الميزانية (اختياري)','NUMBER',false,6,'{"min":0}'::jsonb)
    on conflict (service_id,key) do nothing;

    if s.requires_destination then
      insert into service_fields(service_id,key,label_en,label_fr,label_ar,type,is_required,sort_order,validation)
      values
        (s.id,'pickup_details','Pickup details','Détails de récupération','تفاصيل الاستلام','TEXT',false,7,'{}'::jsonb),
        (s.id,'destination_address','Destination address','Adresse de destination','عنوان الوجهة','ADDRESS',true,8,'{}'::jsonb),
        (s.id,'destination_floor','Floor / access notes','Étage / accès','الطابق / الوصول','TEXT',false,9,'{}'::jsonb),
        (s.id,'needs_helper','Need help carrying?','Besoin d''aide pour porter ?','هل تحتاج مساعدة في الحمل؟','BOOLEAN',false,10,'{}'::jsonb)
      on conflict (service_id,key) do nothing;
    end if;
  end loop;
end $$;

select seed_common_fields();
drop function seed_common_fields();

-- Options for the urgency select on every service
insert into service_field_options(field_id,value,label_en,label_fr,label_ar,sort_order)
select f.id, v.val, v.en, v.fr, v.ar, v.so
from service_fields f
cross join (values
  ('LOW','Not urgent (this week)','Pas urgent (cette semaine)','غير مستعجل (هذا الأسبوع)',1),
  ('NORMAL','Within 1-2 days','Dans 1-2 jours','خلال 1-2 يوم',2),
  ('HIGH','Today','Aujourd''hui','اليوم',3),
  ('URGENT','Right now','Tout de suite','الآن',4)
) as v(val,en,fr,ar,so)
where f.key='urgency'
on conflict (field_id, value) do nothing;

-- Service-specific extra questions (examples of per-service flexibility)
insert into service_fields(service_id,key,label_en,type,is_required,sort_order,validation)
select s.id,'appliance_brand','Appliance brand / model','TEXT',false,11,'{}'::jsonb
from services s where s.slug in ('washing-machine','refrigerator','oven-repair')
on conflict (service_id,key) do nothing;

insert into service_fields(service_id,key,label_en,type,is_required,sort_order,validation)
select s.id,'rooms','Number of rooms','NUMBER',true,11,'{"min":1,"max":20}'::jsonb
from services s where s.slug in ('interior-room','apartment-painting','standard-cleaning','deep-cleaning','post-construction')
on conflict (service_id,key) do nothing;

insert into service_fields(service_id,key,label_en,type,is_required,sort_order,validation)
select s.id,'item_description','What are we moving?','TEXTAREA',true,11,'{"maxLength":500}'::jsonb
from services s where s.slug in ('apartment-move','single-item-move','studio-move','package-transport','fragile-transport')
on conflict (service_id,key) do nothing;

-- ---------------------------------------------------------------------
-- Commission & cancellation configuration (data, not code)
-- ---------------------------------------------------------------------
insert into commission_rules(scope,model,percent_bps,fixed_minor,min_fee_minor,currency,priority)
select 'GLOBAL','PERCENT',1500,null,500,'MAD',0
where not exists (select 1 from commission_rules where scope='GLOBAL' and service_id is null and category_id is null);

insert into commission_rules(scope,category_id,model,percent_bps,min_fee_minor,currency,priority)
select 'CATEGORY', c.id, 'PERCENT', v.bps, 500, 'MAD', 10
from (values ('home-services',1500),('moving-delivery',1500),('personal-tasks',1800)) as v(slug,bps)
join categories c on c.slug=v.slug
where not exists (select 1 from commission_rules cr where cr.category_id=c.id and cr.scope='CATEGORY');

insert into cancellation_policies(scope,stage,cancelled_by,fee_model,fee_percent_bps,fee_fixed_minor,cap_minor,reliability_penalty,description)
select 'GLOBAL', v.stage, v.side::bidly_actor_side, v.model, v.bps, v.fixed, v.cap, v.pen, v.descr
from (values
  ('DRAFT','CUSTOMER','NONE',null::int,null::bigint,null::bigint,false,'Before publishing — free'),
  ('PUBLISHED','CUSTOMER','NONE',null::int,null::bigint,null::bigint,false,'Before a provider is selected — free'),
  ('RECEIVING_OFFERS','CUSTOMER','NONE',null::int,null::bigint,null::bigint,false,'Before selection — free'),
  ('PROVIDER_SELECTED','CUSTOMER','PERCENT',1000,null::bigint,5000::bigint,false,'After selecting a provider — 10% capped'),
  ('CONFIRMED','CUSTOMER','PERCENT',2000,null::bigint,10000::bigint,false,'After confirmation — 20% capped'),
  ('PROVIDER_EN_ROUTE','CUSTOMER','PERCENT',3000,null::bigint,15000::bigint,true,'Provider already travelling — 30%'),
  ('IN_PROGRESS','CUSTOMER','PERCENT',5000,null::bigint,25000::bigint,true,'Work started — 50%'),
  ('CONFIRMED','PROVIDER','PERCENT',1000,null::bigint,5000::bigint,true,'Provider cancels after confirmation — 10% penalty'),
  ('IN_PROGRESS','PROVIDER','PERCENT',2000,null::bigint,10000::bigint,true,'Provider cancels mid-job — 20% penalty')
) as v(stage,side,model,bps,fixed,cap,pen,descr)
where not exists (select 1 from cancellation_policies cp where cp.stage=v.stage and cp.cancelled_by=v.side::bidly_actor_side and cp.scope='GLOBAL');

commit;

-- =====================================================================
-- Settings & feature flags (typed config store)
-- =====================================================================
begin;

insert into settings(key,value,value_type,group_name,description,is_public) values
  ('platform.name',            '"BIDLY"',                       'string',  'general',      'Platform display name', true),
  ('platform.default_country', '"MA"',                          'string',  'general',      'Default country code', true),
  ('platform.default_currency','"MAD"',                         'string',  'general',      'Default currency', true),
  ('platform.default_locale',  '"ar"',                          'string',  'general',      'Default locale', true),
  ('platform.supported_locales','["ar","fr","en"]',             'array',   'general',      'Supported locales', true),
  ('platform.support_email',   '"support@bidly.ma"',            'string',  'general',      'Support email', true),
  ('requests.offer_expiry_minutes',    '30',                    'number',  'marketplace',  'Minutes before a provider offer expires', true),
  ('requests.request_expiry_hours',    '72',                    'number',  'marketplace',  'Hours before an open request expires', true),
  ('requests.max_open_per_customer',   '10',                    'number',  'marketplace',  'Max concurrent open requests per customer', false),
  ('requests.max_offers_per_request',  '25',                    'number',  'marketplace',  'Max live offers per request', false),
  ('matching.initial_radius_km',       '10',                    'number',  'matching',     'Initial matching radius', false),
  ('matching.max_radius_km',           '40',                    'number',  'matching',     'Maximum matching radius', false),
  ('matching.max_candidates',          '50',                    'number',  'matching',     'Max providers notified per run', false),
  ('payments.default_provider',        '"internal"',            'string',  'payments',     'Active payment provider adapter', false),
  ('payments.auto_capture',            'false',                 'boolean', 'payments',     'Capture payment automatically at completion', false),
  ('payments.min_payout_minor',        '5000',                  'number',  'payments',     'Minimum payout amount (minor units)', true),
  ('payments.payout_delay_hours',      '24',                    'number',  'payments',     'Hours before new earnings can be paid out', false),
  ('commission.default_bps',           '1500',                  'number',  'payments',     'Default commission in basis points', true),
  ('security.max_login_attempts',      '5',                     'number',  'security',     'Failed logins before lockout', false),
  ('security.lockout_minutes',         '15',                    'number',  'security',     'Account lockout duration', false),
  ('security.otp_length',              '6',                     'number',  'security',     'OTP code length', false),
  ('security.otp_ttl_seconds',         '300',                   'number',  'security',     'OTP lifetime', false),
  ('security.session_ttl_days',        '30',                    'number',  'security',     'Refresh token lifetime (days)', false),
  ('security.access_token_ttl_minutes','15',                    'number',  'security',     'Access token lifetime (minutes)', false),
  ('uploads.max_image_mb',             '10',                    'number',  'uploads',      'Max image upload size', true),
  ('uploads.max_video_mb',             '50',                    'number',  'uploads',      'Max video upload size', true),
  ('uploads.allowed_image_types',      '["image/jpeg","image/png","image/webp"]','array','uploads','Allowed image MIME types', true),
  ('features.wallet_enabled',          'true',                  'boolean', 'features',     'Enable provider wallet', false),
  ('features.negotiation_enabled',     'true',                  'boolean', 'features',     'Enable counter-offers', false),
  ('features.realtime_enabled',        'true',                  'boolean', 'features',     'Enable websocket realtime', false),
  ('features.reviews_enabled',         'true',                  'boolean', 'features',     'Enable reviews', true),
  ('features.promotions_enabled',      'false',                 'boolean', 'features',     'Enable promotions/coupons', false)
on conflict (key) do update set value=excluded.value, value_type=excluded.value_type,
  group_name=excluded.group_name, description=excluded.description, is_public=excluded.is_public;

insert into feature_flags(key,enabled,rollout_percent,description) values
  ('wallet',              true, 100, 'Provider wallet & payouts'),
  ('negotiation',         true, 100, 'Counter-offer negotiation'),
  ('realtime_tracking',   false,  0, 'Live provider tracking (phase 2)'),
  ('promotions',          false,  0, 'Promotions & coupons (phase 2)'),
  ('ai_categorisation',   false,  0, 'AI category suggestion (phase 3)')
on conflict (key) do update set enabled=excluded.enabled, rollout_percent=excluded.rollout_percent, description=excluded.description;

-- ---------------------------------------------------------------------
-- DEV ONLY users. Fake identities, fake passwords.
-- All three accounts share the documented dev password: BidlyDev!2026
-- (Argon2id hash below is a development placeholder.)
-- ---------------------------------------------------------------------
do $$
declare
  v_hash text := '$argon2id$v=19$m=65536,t=3,p=4$DEVPLACEHOLDERHASH$devplaceholder';
  v_cust uuid; v_prov uuid; v_admin uuid; v_prov_entity uuid;
begin
  -- Customer
  select id into v_cust from users where email='customer@bidly.test';
  if v_cust is null then
    insert into users(email,phone,password_hash,role,status,email_verified_at,phone_verified_at,locale,country_code)
    values ('customer@bidly.test','+212600000101',v_hash,'CUSTOMER','ACTIVE',now(),now(),'ar','MA')
    returning id into v_cust;
  end if;
  insert into user_profiles(user_id,full_name,display_name,preferred_locale,preferred_currency)
  values (v_cust,'Youssef El Amrani','Youssef','ar','MAD')
  on conflict (user_id) do nothing;

  -- Provider (user + provider entity + wallet + service)
  select id into v_prov from users where email='provider@bidly.test';
  if v_prov is null then
    insert into users(email,phone,password_hash,role,status,email_verified_at,phone_verified_at,locale,country_code)
    values ('provider@bidly.test','+212600000102',v_hash,'PROVIDER','ACTIVE',now(),now(),'ar','MA')
    returning id into v_prov;
  end if;
  insert into user_profiles(user_id,full_name,display_name,preferred_locale,preferred_currency)
  values (v_prov,'Karim Benjelloun','Karim Plumbing','ar','MAD')
  on conflict (user_id) do nothing;

  select id into v_prov_entity from providers where user_id=v_prov;
  if v_prov_entity is null then
    insert into providers(user_id,display_name,bio,status,verification_status,verified_at,
                          rating_avg,rating_count,completed_jobs,is_online,languages,
                          country_code,city_id,service_radius_km)
    select v_prov,'Karim Plumbing','Licensed plumber, 8 years experience in Rabat.',
           'ACTIVE','VERIFIED',now(),4.80,12,12,true,array['ar','fr'],'MA',c.id,15
    from cities c where c.slug='rabat'
    returning id into v_prov_entity;
  end if;

  -- provider wallet
  insert into wallets(owner_type,owner_id,currency)
  values ('PROVIDER',v_prov,'MAD')
  on conflict (owner_type,owner_id,currency) do nothing;

  -- provider services: all services
  insert into provider_services(provider_id,service_id,min_price_minor,max_price_minor,currency,eta_minutes,experience_years)
  select v_prov_entity, s.id, coalesce(s.min_price_minor,2000), coalesce(s.max_price_minor,200000),'MAD',45,8
  from services s
  where s.is_active
  on conflict (provider_id,service_id) do nothing;

  insert into provider_service_areas(provider_id,city_id,center_lat,center_lng,radius_km)
  select v_prov_entity, c.id, c.lat, c.lng, 15
  from cities c where c.slug in ('rabat','sale')
  and not exists (select 1 from provider_service_areas psa
                  where psa.provider_id = v_prov_entity and psa.city_id = c.id);

  -- Admin
  insert into admins(email,full_name,password_hash,role,permissions,must_change_password)
  values ('admin@bidly.test','BIDLY Admin',v_hash,
          'SUPER_ADMIN', array['*'],false)
  on conflict (email) do nothing;

  -- Admin staff also need a users row: login resolves the account from
  -- `users`, then loads admin powers from `admins` via admins.user_id. Without
  -- this link the seeded admin cannot sign in.
  insert into users(email,phone,password_hash,role,status,email_verified_at,phone_verified_at,locale,country_code)
  select 'admin@bidly.test','+212600000100',v_hash,'ADMIN','ACTIVE',now(),now(),'ar','MA'
  where not exists (select 1 from users where email='admin@bidly.test');

  update admins a set user_id = u.id
  from users u
  where u.email = 'admin@bidly.test' and a.email = 'admin@bidly.test' and a.user_id is distinct from u.id;

exception when others then
  raise exception 'Seed user block failed: % (%)', sqlerrm, sqlstate;
end $$;

commit;

-- =====================================================================
-- Verification
-- =====================================================================
do $$
declare c int;
begin
  select count(*) into c from categories;        raise notice 'categories: %', c;
  select count(*) into c from subcategories;     raise notice 'subcategories: %', c;
  select count(*) into c from services;          raise notice 'services: %', c;
  select count(*) into c from service_fields;    raise notice 'service_fields: %', c;
  select count(*) into c from service_field_options; raise notice 'field_options: %', c;
  select count(*) into c from settings;          raise notice 'settings: %', c;
  select count(*) into c from commission_rules;  raise notice 'commission_rules: %', c;
  select count(*) into c from cancellation_policies; raise notice 'cancellation_policies: %', c;
end $$;
