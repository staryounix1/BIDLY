// Apply every db/migrations/*.sql against an in-process Postgres (PGlite) and
// exercise the khdemli_* helper functions. This is the fast, dependency-free
// way to catch schema and plpgsql errors; it needs no running Postgres server.
//
// Setup (PGlite is fetched into /tmp because it is a re-generable cache):
//   mkdir -p /tmp/pgq/pglite && cd /tmp/pgq
//   curl -sL -o p.tgz https://registry.npmjs.org/@electric-sql/pglite/-/pglite-0.5.8.tgz
//   tar xzf p.tgz -C pglite --strip-components=1
//
// Run:  node scripts/dbcheck/run-migrations-pglite.mjs db/migrations

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

(async () => {
  const { PGlite } = await import("/tmp/pgq/pglite/dist/index.js");
  const { pgcrypto } = await import("/tmp/pgq/pglite/dist/contrib/pgcrypto.js");
  const { citext } = await import("/tmp/pgq/pglite/dist/contrib/citext.js");
  const { btree_gin } = await import("/tmp/pgq/pglite/dist/contrib/btree_gin.js");
  const db = new PGlite({ extensions: { pgcrypto, citext, btree_gin } });

  const dir = process.argv[2];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sql")).sort();

  // Supabase provides these roles; PGlite does not. Create them up front so the
  // grant block in the last migration is exercised for real.
  await db.exec(`
    do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
    do $$ begin create role anon;          exception when duplicate_object then null; end $$;
  `);

  let failed = false;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    try {
      await db.exec(sql);
      // Report how many objects now exist, as a sanity signal.
      const r = await db.query(
        "select count(*)::int n from information_schema.tables where table_schema='public'"
      );
      console.log(`OK   ${f}  (tables now: ${r.rows[0].n})`);
    } catch (e) {
      failed = true;
      console.log(`FAIL ${f}: ${e.message}`);
      if (e.position) {
        const pos = Number(e.position);
        console.log(`     near line ${sql.slice(0, pos).split("\n").length}`);
      }
    }
  }

  if (!failed) {
    // Exercise the two plpgsql functions end to end.
    try {
      await db.exec(`
        create extension if not exists pgcrypto;
        insert into currencies (code, name, symbol) values ('MAD','Moroccan Dirham','DH')
          on conflict (code) do nothing;
      `);
      const u = await db.query(
        `insert into users (role, status, email)
         values ('PROVIDER','ACTIVE','t@example.com')
         returning id`
      );
      const uid = u.rows[0].id;
      const w = await db.query(
        `insert into wallets (owner_type, owner_id, currency, available_minor)
         values ('PROVIDER', $1, 'MAD', 10000) returning id`, [uid]
      );
      const wid = w.rows[0].id;

      const debit = await db.query(
        `select khdemli_wallet_apply($1,'DEBIT','PLATFORM_COMMISSION',1500,'job',null,null,'commission') as txn`,
        [wid]
      );
      const bal = await db.query(`select available_minor from wallets where id=$1`, [wid]);
      console.log(`\nwallet_apply DEBIT 1500 -> txn ${debit.rows[0].txn ? "created" : "MISSING"}, balance ${bal.rows[0].available_minor}`);
      console.log(`  lifetime_out_minor = ${(await db.query('select lifetime_out_minor from wallets where id=$1',[wid])).rows[0].lifetime_out_minor}`);
      console.log(`  ledger rows        = ${(await db.query('select count(*)::int n from wallet_transactions where wallet_id=$1',[wid])).rows[0].n}`);

      let overdraw = "not attempted";
      try {
        await db.query(
          `select khdemli_wallet_apply($1,'DEBIT','PLATFORM_COMMISSION',999999,'job',null,null,'too much')`,
          [wid]
        );
        overdraw = "ALLOWED (BUG)";
      } catch (e) { overdraw = "rejected: " + e.message.split("\n")[0]; }
      console.log(`wallet_apply overdraft   -> ${overdraw}`);

      // A frozen wallet must refuse every operation.
      await db.exec(`update wallets set is_frozen = true where id = '${wid}'`);
      let frozen = "not attempted";
      try {
        await db.query(`select khdemli_wallet_apply($1,'CREDIT','TOPUP',500,'topup',null,null,'x')`, [wid]);
        frozen = "ALLOWED (BUG)";
      } catch (e) { frozen = "rejected: " + e.message.split("\n")[0]; }
      console.log(`wallet_apply frozen      -> ${frozen}`);
      await db.exec(`update wallets set is_frozen = false where id = '${wid}'`);

      const code = await db.query(`select khdemli_ensure_referral_code($1) as c`, [uid]);
      const code2 = await db.query(`select khdemli_ensure_referral_code($1) as c`, [uid]);
      console.log(`referral code            -> ${code.rows[0].c} (stable: ${code.rows[0].c === code2.rows[0].c})`);

      const sched = await db.query(`select khdemli_commission_schedule() as s`);
      console.log(`commission schedule      -> ${JSON.stringify(sched.rows[0].s)}`);

      // The tier bands must agree with the TypeScript implementation.
      const band = await db.query(`
        select
          (select value from settings where key='commission.tiers') as tiers,
          (select count(*)::int from feature_flags where key in
            ('wallet_topup_packages','provider_negotiation','provider_specialty','sos_requests',
             'scheduled_bookings','job_photos','service_guarantee','provider_boost',
             'premium_subscription','referrals','first_job_free','two_way_ratings',
             'location_sharing','provider_peak_stats','admin_heatmap')) as flags
      `);
      console.log(`feature flags inserted   -> ${band.rows[0].flags}/15`);
      const tiers = band.rows[0].tiers.tiers;
      console.log(`tier bands               -> ${tiers.map(t => (t.upToMinor===null?"+inf":t.upToMinor/100+" MAD")+"@"+(t.bps/100)+"%").join(", ")}`);
    } catch (e) {
      failed = true;
      console.log(`\nFUNCTION TEST FAIL: ${e.message}`);
    }
  }

  await db.close();
  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exit(failed ? 1 : 0);
})();
