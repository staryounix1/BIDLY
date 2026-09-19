# BIDLY — نشر مجاني على Oracle Cloud Always Free

هذه الحزمة تشغّل المشروع كاملاً (API + واجهة + قاعدة بيانات + HTTPS) على VPS واحد.

## المتطلبات
- حساب Oracle Cloud (Always Free). البطاقة للتحقق فقط، بلا سحب.
- جهاز/إنstance بـ **Ubuntu 22.04 أو 24.04**، مستعمل مفعّل، و**منفذان 80 و443 مفتوحان**.

### إنشاء الـ instance (ملخص)
1. Oracle Cloud → **Compute → Instances → Create instance**.
2. Image: **Canonical Ubuntu 22.04**.
3. Shape: اختر **VM.Standard.A1.Flex** (ARM، مجاني دائماً). فعّل 2 OCPU و12 GB RAM إن أمكن — يكفي 1 OCPU / 6 GB. إن لم يتوفر A1 استخدم **VM.Standard.E2.1.Micro**.
4. حمّل مفتاح SSH واحفظه.
5. بعد التشغيل: **Networking → Virtual Cloud Networks → Security Lists → Default → Add Ingress Rules**:
   - Source `0.0.0.0/0`, TCP, Destination Port `80`
   - Source `0.0.0.0/0`, TCP, Destination Port `443`
   - خيارياً `22` إن أردت SSH من أي مكان.

## الاتصال
```bash
ssh -i /path/to/key ubuntu@<PUBLIC_IP>
```

## النشر (نسخ ولصق)
```bash
# 1) ارفع المشروع إلى الـ VM (من جهازك):
scp -i /path/to/key -r BIDLY ubuntu@<PUBLIC_IP>:~/BIDLY

# 2) على الـ VM:
cd ~/BIDLY/deploy/oracle
cp .env.example .env
nano .env        # املأ كل REPLACE_ME
bash setup.sh
```

## الحقول التي يجب تعديلها في `.env`
| الحقل | القيمة |
|---|---|
| `SITE_DOMAIN` | IP العام للـ VM، أو نطاقك |
| `PUBLIC_API_URL` | `https://<نفس القيمة>` |
| `POSTGRES_PASSWORD` | أي كلمة مرور قوية |
| `AUTH_SECRET` | 64 حرفاً عشوائياً: `openssl rand -hex 32` |
| `REFRESH_SECRET` | 64 حرفاً عشوائياً: `openssl rand -hex 32` |
| `PAYMENT_WEBHOOK_SECRET` | `openssl rand -hex 32` |
| `CORS_ORIGINS` `API_URL` `APP_URL` | `https://<نفس القيمة>` |

## HTTPS
- **بنطاق حقيقي** (موصى به): وجّه سجل DNS من نوع `A` للنطاق إلى IP الـ VM، وضع النطاق في
  `SITE_DOMAIN`. Caddy يحصل على شهادة HTTPS تلقائياً.
- **بالـ IP فقط** (`SITE_DOMAIN=1.2.3.4` أو `http://1.2.3.4`): لا HTTPS تلقائي. عدّل
  `Caddyfile` ليبدأ بـ `http://` وستعمل الواجهة والـ API على HTTP. ليس مثالياً للإنتاج.

## ملاحظات مهمة
- **البريد/SMS**: في هذا الوضع رسائل التحقق (OTP) تُطبع في سجلات الـ API بدلاً من إرسالها:
  `docker compose logs -f api | grep -i "code is"`. لتفعيل إرسال حقيقي، أضف `RESEND_API_KEY`
  واضبط `EMAIL_PROVIDER=resend`.
- **المدفوعات**: `PAYMENT_PROVIDER=internal` مع `PAYMENT_SANDBOX=true` — وضع تجريبي.
- **الترقية**: `git pull` ثم `docker compose up -d --build`.
- **الحالة**: `docker compose ps` — **السجلات**: `docker compose logs -f api`.
- **حساب admin**: البذرة لا تُنشئ مستخدم admin جاهزاً للإنتاج. أنشئ حساباً عبر الواجهة
  ثم رقّيه في قاعدة البيانات إن احتجت لوحة الإدارة.
