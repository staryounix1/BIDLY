import type { FastifyInstance } from 'fastify';
import { forbidden, notFound, businessRule } from '../../core/errors.js';
import { clientQuery, queryMany, queryOne, transaction } from '../../db/pool.js';
import { buildPage, parsePagination } from '../../core/pagination.js';
import { PaymentProviderRegistry } from './payment-provider.js';
import { LOG_EVENTS, logEvent } from '../../core/logger.js';
import { env } from '@bidly/config';

/**
 * /payments, /wallets, /payouts — money movement.
 *
 * Every balance change goes through `wallet_transactions`; the ledger trigger
 * verifies the running balance. Capturing a payment debits the customer's
 * charge, records the platform commission, and credits the provider wallet —
 * all in one database transaction, so a crash can never lose or duplicate
 * money.
 */
export async function registerPaymentRoutes(app: FastifyInstance): Promise<void> {
  const registry = new PaymentProviderRegistry(env.PAYMENT_PROVIDER, env.PAYMENT_WEBHOOK_SECRET);

  async function loadPaymentForActor(paymentId: string, userId: string, role: string) {
    const payment = await queryOne<Record<string, unknown>>(
      `select pm.*, p.user_id as provider_user_id
       from payments pm left join providers p on p.id = pm.provider_id
       where pm.id = $1`,
      [paymentId],
    );
    if (!payment) throw notFound('Payment');
    const isCustomer = payment.customer_id === userId;
    const isProvider = payment.provider_user_id === userId;
    if (!isCustomer && !isProvider && role !== 'ADMIN') throw forbidden();
    return { payment, isCustomer, isProvider };
  }

  // -------- pay a job ---------------------------------------------------
  app.post('/payments/job/:jobId/pay', {
    preHandler: [app.requireCustomer],
    schema: {
      tags: ['payments'],
      summary: 'Authorize and capture payment for a job (idempotent)',
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: { method: { type: 'string', enum: ['CARD', 'CASH', 'PAYPAL', 'BANK_TRANSFER', 'WALLET'] } },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { jobId } = request.params as { jobId: string };
    const b = (request.body ?? {}) as { method?: string };
    const method = b.method ?? 'CARD';

    const provider = registry.get();

    const result = await transaction(async (client) => {
      const c = clientQuery(client);

      const payment = await c.one<{
        id: string; job_id: string; customer_id: string; provider_id: string | null;
        amount_minor: string; currency: string; status: string; commission_minor: string;
        provider_net_minor: string; provider_ref: string | null; job_status: string;
      }>(
        `select pm.id, pm.job_id, pm.customer_id, pm.provider_id, pm.amount_minor, pm.currency,
                pm.status, pm.commission_minor, pm.provider_net_minor, pm.provider_ref,
                j.status as job_status
         from payments pm join jobs j on j.id = pm.job_id
         where pm.job_id = $1 for update`,
        [jobId],
      );
      if (!payment) throw notFound('Payment');
      if (payment.customer_id !== auth.userId) throw forbidden();
      if (['CAPTURED', 'AUTHORIZED'].includes(payment.status)) {
        // Idempotent: paying twice returns the existing record.
        return { paymentId: payment.id, status: payment.status, alreadyPaid: true };
      }
      // A previous attempt that already emitted a CAPTURE success row must not
      // be charged twice even if the payment row was left mid-flight.
      const capturedTxn = await c.one<{ id: string }>(
        `select id from payment_transactions
         where payment_id = $1 and type = 'CAPTURE' and status = 'SUCCESS' limit 1`,
        [payment.id],
      );
      if (capturedTxn) {
        return { paymentId: payment.id, status: 'CAPTURED', alreadyPaid: true };
      }
      if (!['COMPLETED', 'PAYMENT_PENDING'].includes(payment.job_status)) {
        throw businessRule('Payment is only available once the job is completed.');
      }
      if (!['PENDING', 'FAILED'].includes(payment.status)) throw businessRule(`This payment is in status ${payment.status}.`);

      const amountMinor = Number(payment.amount_minor);
      const idempotencyKey = `pay:${payment.id}`;

      const intent = await provider.createIntent({
        paymentId: payment.id,
        amountMinor,
        currency: payment.currency,
        method: method as never,
        customerId: payment.customer_id,
        jobId: payment.job_id,
        idempotencyKey,
      });

      const authResult = await provider.authorize({
        providerRef: intent.providerRef,
        amountMinor,
        currency: payment.currency,
        idempotencyKey,
      });

      if (authResult.status === 'FAILED') {
        await c.query(
          `insert into payment_transactions (payment_id, job_id, type, provider_name, provider_ref, amount_minor, currency, status, idempotency_key, error_code, error_message, raw_payload)
           values ($1,$2,'AUTHORIZE',$3,$4,$5,$6,'FAILED',$7,'AUTH_FAILED','The payment was declined by the provider.','{}'::jsonb)`,
          [payment.id, payment.job_id, provider.name, authResult.providerRef, amountMinor, payment.currency, idempotencyKey],
        );
        await c.query(
          `update payments set status = 'FAILED', provider_name = $2, provider_ref = $3, method = $4,
                  failed_at = now(), failure_code = 'AUTH_FAILED', failure_message = 'The payment was declined by the provider.'
           where id = $1`,
          [payment.id, provider.name, authResult.providerRef, method],
        );
        logEvent(LOG_EVENTS.PAYMENT_FAILED, { userId: auth.userId, paymentId: payment.id, jobId: payment.job_id });
        return { paymentId: payment.id, status: 'FAILED', amountMinor, currency: payment.currency, retryable: true };
      }

      await c.query(
        `insert into payment_transactions (payment_id, job_id, type, provider_name, provider_ref, amount_minor, currency, status, idempotency_key, raw_payload)
         values ($1,$2,'AUTHORIZE',$3,$4,$5,$6,'SUCCESS',$7,$8::jsonb)`,
        [
          payment.id, payment.job_id, provider.name, authResult.providerRef, amountMinor,
          payment.currency, idempotencyKey, JSON.stringify({ method, simulated: true }),
        ],
      );

      const capResult = await provider.capture({
        providerRef: intent.providerRef,
        amountMinor,
        currency: payment.currency,
        idempotencyKey: `${idempotencyKey}:capture`,
      });

      if (capResult.status === 'FAILED') {
        await c.query(
          `insert into payment_transactions (payment_id, job_id, type, provider_name, provider_ref, amount_minor, currency, status, idempotency_key, error_code, error_message, raw_payload)
           values ($1,$2,'CAPTURE',$3,$4,$5,$6,'FAILED',$7,'CAPTURE_FAILED','The payment could not be captured.','{}'::jsonb)`,
          [payment.id, payment.job_id, provider.name, capResult.providerRef, amountMinor, payment.currency, `${idempotencyKey}:capture`],
        );
        await c.query(
          `update payments set status = 'FAILED', provider_name = $2, provider_ref = $3, method = $4,
                  failed_at = now(), failure_code = 'CAPTURE_FAILED', failure_message = 'The payment could not be captured.'
           where id = $1`,
          [payment.id, provider.name, authResult.providerRef, method],
        );
        logEvent(LOG_EVENTS.PAYMENT_FAILED, { userId: auth.userId, paymentId: payment.id, jobId: payment.job_id });
        return { paymentId: payment.id, status: 'FAILED', amountMinor, currency: payment.currency, retryable: true };
      }

      await c.query(
        `insert into payment_transactions (payment_id, job_id, type, provider_name, provider_ref, amount_minor, currency, status, idempotency_key, raw_payload)
         values ($1,$2,'CAPTURE',$3,$4,$5,$6,'SUCCESS',$7,'{}'::jsonb)`,
        [payment.id, payment.job_id, provider.name, capResult.providerRef, amountMinor, payment.currency, `${idempotencyKey}:capture`],
      );

      await c.query(
        `update payments set status = 'CAPTURED', provider_name = $2, provider_ref = $3,
               captured_minor = amount_minor, authorized_at = now(), captured_at = now(), method = $4
         where id = $1`,
        [payment.id, provider.name, capResult.providerRef, method],
      );

      await c.query(
        `update jobs set payment_status = 'CAPTURED', status = 'PAID' where id = $1 and status in ('COMPLETED','PAYMENT_PENDING')`,
        [payment.job_id],
      );

      const commissionMinor = Number(payment.commission_minor);
      const providerNetMinor = amountMinor - commissionMinor;

      // Platform earnings row
      await c.query(
        `insert into platform_earnings (payment_id, job_id, currency, gross_minor, commission_minor)
         select $1, $2, $3, $4, $5 from jobs j where j.id = $2`,
        [payment.id, payment.job_id, payment.currency, amountMinor, commissionMinor],
      );

      // Credit the provider wallet through the ledger (append-only).
      if (payment.provider_id) {
        const providerUserId = await c.one<{ user_id: string }>('select user_id from providers where id = $1', [payment.provider_id]);
        if (providerUserId) {
          const wallet = await c.one<{ id: string; available_minor: string }>(
            `insert into wallets (owner_type, owner_id, currency) values ('PROVIDER', $1, $2)
             on conflict (owner_type, owner_id, currency) do update set updated_at = now()
             returning id, available_minor`,
            [providerUserId.user_id, payment.currency],
          );
          if (wallet) {
            const newBalance = Number(wallet.available_minor) + providerNetMinor;
            await c.query(
              `insert into wallet_transactions (wallet_id, type, direction, amount_minor, currency, balance_after_minor,
                                                reference_type, reference_id, job_id, payment_id, description)
               values ($1,'JOB_EARNING','CREDIT',$2,$3,$4,'payment',$5,$6,$7,$8)`,
              [
                wallet.id, providerNetMinor, payment.currency, newBalance,
                payment.id, payment.job_id, payment.id,
                `Earning for job ${payment.job_id}`,
              ],
            );

            await c.query(
              `update providers set completed_jobs = completed_jobs + 1 where id = $1`,
              [payment.provider_id],
            );
          }
        }
      }

      logEvent(LOG_EVENTS.PAYMENT_CAPTURED, {
        userId: auth.userId, paymentId: payment.id, jobId: payment.job_id, amountMinor, commissionMinor,
      });

      return {
        paymentId: payment.id,
        status: 'CAPTURED',
        amountMinor,
        currency: payment.currency,
        commissionMinor,
        providerNetMinor,
      };
    });

    return reply.send({ success: true, data: result });
  });

  // -------- payment detail ---------------------------------------------
  app.get('/payments/:id', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['payments'], summary: 'Payment detail with its transaction log', security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const { id } = request.params as { id: string };
    const { payment } = await loadPaymentForActor(id, auth.userId, auth.role);
    const transactions = await queryMany(
      `select id, type, provider_name, provider_ref, amount_minor, currency, status, error_code, created_at
       from payment_transactions where payment_id = $1 order by created_at`,
      [id],
    );
    const refunds = await queryMany(
      `select id, amount_minor, currency, status, reason, is_partial, created_at, processed_at
       from refunds where payment_id = $1 order by created_at`,
      [id],
    );
    return reply.send({ success: true, data: { payment, transactions, refunds } });
  });

  // -------- wallets ------------------------------------------------------
  /**
   * Resolve the wallet that belongs to the signed-in user.
   *
   * A person's balance is held under one of two owner kinds: a provider is paid
   * into a PROVIDER wallet keyed by their `providers.id`, while everyone else
   * (customers, and staff browsing their own account) holds a USER wallet keyed
   * by `users.id`. Returning `null` is a valid answer — it simply means the
   * account has no wallet yet — so the caller decides how to present that.
   */
  async function walletForUser(userId: string) {
    return queryOne(
      `select w.* from wallets w
       where (w.owner_type = 'PROVIDER' and w.owner_id = (select id from providers where user_id = $1))
          or (w.owner_type = 'USER' and w.owner_id = $1)
       order by (w.owner_type = 'PROVIDER') desc
       limit 1`,
      [userId],
    );
  }

  app.get('/wallets/me', {
    preHandler: [app.requireUser],
    schema: { tags: ['payments'], summary: 'My wallet', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const wallet = await walletForUser(auth.userId);
    return reply.send({ success: true, data: wallet });
  });

  app.get('/wallets/me/transactions', {
    preHandler: [app.requireUser],
    schema: {
      tags: ['payments'], summary: 'My wallet ledger', security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object', additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
          type: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const q = request.query as Record<string, unknown>;
    const page = parsePagination(q);
    const wallet = await walletForUser(auth.userId);
    if (!wallet) return reply.send({ success: true, data: [] });

    const where = ['wt.wallet_id = $1'];
    const params: unknown[] = [(wallet as { id: string }).id];
    if (q.type) { params.push(q.type); where.push(`wt.type = $${params.length}`); }

    const rows = await queryMany(
      `select wt.id, wt.type, wt.direction, wt.amount_minor, wt.currency, wt.balance_after_minor,
              wt.reference_type, wt.reference_id, wt.job_id, wt.description, wt.created_at
       from wallet_transactions wt
       where ${where.join(' and ')} order by wt.created_at desc
       limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, page.limit, page.offset],
    );
    return reply.send({ success: true, data: rows });
  });

  // -------- payouts ------------------------------------------------------
  app.post('/payouts', {
    preHandler: [app.requireProvider],
    schema: {
      tags: ['payments'],
      summary: 'Request a payout from the wallet',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['amountMinor'],
        additionalProperties: false,
        properties: {
          amountMinor: { type: 'integer', minimum: 1 },
          method: { type: 'string', enum: ['BANK_TRANSFER', 'CASH', 'WALLET'] },
          destinationMasked: { type: 'string', maxLength: 60 },
        },
      },
    },
  }, async (request, reply) => {
    const auth = request.auth!;
    const b = request.body as { amountMinor: number; method?: string; destinationMasked?: string };

    const payout = await transaction(async (client) => {
      const c = clientQuery(client);
      const provider = await c.one<{ id: string; currency: string }>('select id, currency from providers where user_id = $1', [auth.userId]);
      if (!provider) throw notFound('Provider profile');

      const wallet = await c.one<{ id: string; available_minor: string; reserved_minor: string; is_frozen: boolean; currency: string }>(
        `select id, available_minor, reserved_minor, is_frozen, currency from wallets
         where owner_type = 'PROVIDER' and owner_id = $1 for update`,
        [auth.userId],
      );
      if (!wallet) throw notFound('Wallet');
      if (wallet.is_frozen) throw businessRule('This wallet is frozen. Please contact support.');

      const available = Number(wallet.available_minor);
      if (b.amountMinor > available) {
        throw businessRule('The requested amount exceeds your available balance.');
      }

      const minRow = await c.one<{ value: unknown }>(`select value from settings where key = 'payments.min_payout_minor'`);
      const minPayout = Number(minRow?.value ?? 5000);
      if (b.amountMinor < minPayout) {
        throw businessRule(`The minimum payout amount is ${minPayout} minor units.`);
      }

      const row = await c.one(
        `insert into payouts (provider_id, user_id, wallet_id, amount_minor, currency, method, destination_masked, status)
         values ($1,$2,$3,$4,$5,coalesce($6,'BANK_TRANSFER'),$7,'REQUESTED') returning *`,
        [provider.id, auth.userId, wallet.id, b.amountMinor, wallet.currency, b.method ?? null, b.destinationMasked ?? null],
      );

      // Reserve the funds immediately so the same balance cannot be requested
      // twice: the amount leaves `available_minor` and moves to `reserved_minor`.
      const newBalance = available - b.amountMinor;
      const newReserved = Number(wallet.reserved_minor) + b.amountMinor;
      await c.query(
        `insert into wallet_transactions (wallet_id, type, direction, amount_minor, currency, balance_after_minor,
                                          reference_type, reference_id, description)
         values ($1,'PAYOUT_DEBIT','DEBIT',$2,$3,$4,'payout',$5,$6)`,
        [
          wallet.id, b.amountMinor, wallet.currency, newBalance,
          (row as { id: string }).id, 'Payout requested (reserved)',
        ],
      );
      await c.query(
        `update wallets set available_minor = $2, reserved_minor = $3, updated_at = now() where id = $1`,
        [wallet.id, newBalance, newReserved],
      );

      logEvent(LOG_EVENTS.PAYOUT_REQUESTED, { userId: auth.userId, amountMinor: b.amountMinor });
      return row;
    });

    return reply.status(201).send({ success: true, data: payout });
  });

  app.get('/payouts/mine', {
    preHandler: [app.requireUser],
    schema: { tags: ['payments'], summary: 'My payouts', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    const auth = request.auth!;
    const rows = await queryMany(
      `select id, amount_minor, currency, fee_minor, net_minor, method, destination_masked, status,
              failure_reason, requested_at, processed_at, paid_at
       from payouts where user_id = $1 order by created_at desc limit 100`,
      [auth.userId],
    );
    return reply.send({ success: true, data: rows });
  });

  // -------- provider webhooks -------------------------------------------
  /**
   * Webhook receiver.
   *
   * These endpoints are unauthenticated by nature — the caller is the payment
   * provider, not a signed-in user — so the signature is the only authority.
   * The raw body is verified before anything is parsed, the event is persisted
   * in `webhook_events` for replay protection, and a duplicate (provider,
   * event_id) is acknowledged but never processed twice.
   */
  app.post('/payments/webhook/:provider', {
    schema: {
      tags: ['payments'],
      summary: 'Receive a signed payment-provider webhook',
      params: { type: 'object', required: ['provider'], properties: { provider: { type: 'string', maxLength: 32 } } },
    },
  }, async (request, reply) => {
    const { provider: providerName } = request.params as { provider: string };
    const raw = request.body;
    const rawText = Buffer.isBuffer(raw) ? raw.toString('utf8') : typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
    const signature = String(request.headers['x-bidly-signature'] ?? request.headers['stripe-signature'] ?? '');

    let provider;
    try {
      provider = registry.get(providerName);
    } catch {
      throw notFound('Payment provider');
    }

    const signatureValid = provider.verifyWebhookSignature(rawText, signature);

    let parsed: unknown = {};
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = {};
    }

    const p = parsed as Record<string, unknown>;
    const eventId = typeof p.eventId === 'string' ? p.eventId : (typeof p.id === 'string' ? p.id : null);
    const eventType = typeof p.eventType === 'string' ? p.eventType : 'unknown';

    // Persist first: a replayed event hits the unique (provider, event_id)
    // index and is acknowledged without being applied twice.
    const inserted = await queryOne<{ id: string }>(
      `insert into webhook_events (provider_name, event_id, event_type, signature_valid, payload, status)
       values ($1,$2,$3,$4,$5::jsonb,$6)
       on conflict (provider_name, event_id) where event_id is not null do nothing
       returning id`,
      [provider.name, eventId, eventType, signatureValid, JSON.stringify(p), signatureValid ? 'RECEIVED' : 'FAILED'],
    );

    if (!signatureValid) {
      logEvent(LOG_EVENTS.WEBHOOK_REJECTED, { provider: provider.name, eventId, reason: 'bad_signature' });
      return reply.status(401).send({ success: false, error: { code: 'INVALID_SIGNATURE', message: 'The webhook signature is not valid.' } });
    }

    if (!inserted) {
      // Duplicate event: already received and processed. Acknowledge, do not re-apply.
      return reply.status(200).send({ success: true, data: { duplicate: true } });
    }

    const eventRowId = inserted.id;
    try {
      const normalized = provider.normalizeWebhook(p);
      const payment = normalized.providerRef
        ? await queryOne<{ id: string; job_id: string; status: string; amount_minor: string; currency: string; customer_id: string }>(
            `select id, job_id, status, amount_minor, currency, customer_id from payments where provider_ref = $1`,
            [normalized.providerRef],
          )
        : null;

      if (!payment || !normalized.status) {
        await queryOne(`update webhook_events set status = 'IGNORED', processed_at = now() where id = $1`, [eventRowId]);
        return reply.status(200).send({ success: true, data: { ignored: true } });
      }

      await transaction(async (client) => {
        const c = clientQuery(client);
        const idx = `webhook:${provider.name}:${eventId ?? eventRowId}`;
        await c.query(
          `insert into payment_transactions (payment_id, job_id, type, provider_name, provider_ref, amount_minor, currency, status, idempotency_key, raw_payload)
           values ($1,$2,'WEBHOOK',$3,$4,$5,$6,'SUCCESS',$7,$8::jsonb)
           on conflict (idempotency_key) where idempotency_key is not null do nothing`,
          [
            payment.id, payment.job_id, provider.name, normalized.providerRef,
            normalized.amountMinor ?? Number(payment.amount_minor), payment.currency, idx, JSON.stringify(p),
          ],
        );
        await c.query(`update payments set status = $2, updated_at = now() where id = $1`, [payment.id, normalized.status]);
        if (normalized.status === 'CAPTURED') {
          await c.query(
            `update jobs set payment_status = 'CAPTURED' where id = $1 and payment_status <> 'CAPTURED'`,
            [payment.job_id],
          );
        }
        await c.query(`update webhook_events set status = 'PROCESSED', processed_at = now() where id = $1`, [eventRowId]);
      });

      logEvent(LOG_EVENTS.WEBHOOK_RECEIVED, { provider: provider.name, eventId, eventType, status: normalized.status });
      return reply.status(200).send({ success: true, data: { processed: true, status: normalized.status } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await queryOne(`update webhook_events set status = 'FAILED', error = $2, processed_at = now() where id = $1`, [eventRowId, message.slice(0, 500)]);
      logEvent(LOG_EVENTS.WEBHOOK_REJECTED, { provider: provider.name, eventId, reason: message });
      return reply.status(500).send({ success: false, error: { code: 'WEBHOOK_FAILED', message: 'The webhook could not be processed.' } });
    }
  });
}
