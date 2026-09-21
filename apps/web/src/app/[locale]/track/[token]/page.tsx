'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

/**
 * Public, unauthenticated tracking page.
 *
 * The token in the URL is the credential, so this page deliberately shows the
 * minimum: the job status, the craftsman's display name and a dot on a map.
 * No prices, no addresses, no contact details. It reads from `/track/:token`,
 * which refuses revoked and expired links.
 */

interface TrackPayload {
  jobCode: string;
  status: string;
  providerName: string | null;
  destination: { lat: number; lng: number } | null;
  expiresAt: string;
}

export default function TrackPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token as string;
  const [data, setData] = useState<TrackPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const base = process.env.NEXT_PUBLIC_API_URL ?? '';
    fetch(`${base}/api/v1/track/${token}`)
      .then(async (r) => {
        const json = await r.json();
        if (cancelled) return;
        if (json?.success) setData(json.data);
        else setError(json?.error?.message ?? 'Tracking link unavailable.');
      })
      .catch(() => !cancelled && setError('Tracking link unavailable.'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [token]);

  const dir = typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';

  return (
    <div dir={dir} className="app-shell container-page py-8">
      <div className="card p-5">
        <h1 className="text-xl font-extrabold">Live tracking</h1>

        {loading && <p className="mt-3 text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>Loading…</p>}

        {error && (
          <p className="mt-3 text-sm font-semibold" style={{ color: 'rgb(var(--danger))' }}>{error}</p>
        )}

        {data && (
          <>
            <p className="mt-1 text-xs" style={{ color: 'rgb(var(--fg-subtle))' }}>{data.jobCode}</p>
            <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs font-semibold" style={{ color: 'rgb(var(--fg-subtle))' }}>Status</div>
                <div className="mt-0.5 font-bold">{data.status.replace(/_/g, ' ').toLowerCase()}</div>
              </div>
              {data.providerName && (
                <div>
                  <div className="text-xs font-semibold" style={{ color: 'rgb(var(--fg-subtle))' }}>Craftsman</div>
                  <div className="mt-0.5 font-bold">{data.providerName}</div>
                </div>
              )}
            </div>

            {data.destination && (
              <div className="mt-4 overflow-hidden rounded-xl"
                   style={{ border: '1px solid rgb(var(--line))', height: 320 }}>
                <iframe
                  title="Tracking map"
                  className="h-full w-full"
                  style={{ border: 0 }}
                  src={`https://www.openstreetmap.org/export/embed.html?bbox=${
                    data.destination.lng - 0.01
                  }%2C${data.destination.lat - 0.008}%2C${
                    data.destination.lng + 0.01
                  }%2C${data.destination.lat + 0.008}&layer=mapnik&marker=${
                    data.destination.lat
                  }%2C${data.destination.lng}`}
                />
              </div>
            )}

            <p className="mt-3 text-xs" style={{ color: 'rgb(var(--fg-subtle))' }}>
              This link stops working on {new Date(data.expiresAt).toLocaleString()}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
