import { api } from './auth-api';

/**
 * Referrals — one invite code per user, wallet rewards on the referee's first
 * completed job. Amounts come from `settings` so an admin change is immediate.
 */

export interface Referral {
  id: string;
  status: 'PENDING' | 'REWARDED' | 'EXPIRED' | 'CANCELLED';
  created_at: string;
  rewarded_at: string | null;
  referrer_reward_minor: string | number;
  referee_reward_minor: string | number;
  referee_email: string | null;
}

export interface MyReferrals {
  enabled: boolean;
  code: string | null;
  referrals: Referral[];
  rewarded: number;
  earnedMinor: number;
  rewardMinor: { referrer: number | null; referee: number | null };
}

export const referralsApi = {
  async me(): Promise<MyReferrals> {
    const res = await api.get<MyReferrals>('/referrals/me');
    return res.data;
  },

  async claim(code: string): Promise<{ id: string }> {
    const res = await api.post<{ id: string }>('/referrals/claim', { code });
    return res.data;
  },

  async asReferee(): Promise<{ id: string; status: string; code: string } | null> {
    const res = await api.get<{ id: string; status: string; code: string } | null>('/referrals/mine-as-referee');
    return res.data;
  },
};
