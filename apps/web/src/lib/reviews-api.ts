import { api } from './auth-api';

/**
 * Reviews — two-sided ratings after a job.
 *
 * Both sides rate each other; the customer's review of the provider is public
 * and feeds `providers.rating_avg`, the provider's review of the customer is
 * internal. Neither side has to wait for the other, but the job counts as
 * fully rated only once both exist.
 */

export interface JobReview {
  id: string;
  job_id: string;
  direction: 'CUSTOMER' | 'PROVIDER';
  rating: number;
  comment: string | null;
  rating_punctuality: number | null;
  rating_quality: number | null;
  rating_communication: number | null;
  rating_value: number | null;
  is_visible: boolean;
  created_at: string;
  author_name?: string | null;
}

export interface RatingStatus {
  role: 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
  iRated: boolean;
  theyRated: boolean;
  fullyRated: boolean;
  canRate: boolean;
}

export interface CreateReviewInput {
  jobId: string;
  rating: number;
  comment?: string;
  punctuality?: number;
  quality?: number;
  communication?: number;
  value?: number;
}

export const reviewsApi = {
  async forJob(jobId: string): Promise<JobReview[]> {
    const res = await api.get<JobReview[]>(`/reviews/job/${jobId}`);
    return res.data;
  },

  async status(jobId: string): Promise<RatingStatus> {
    const res = await api.get<RatingStatus>(`/reviews/job/${jobId}/status`);
    return res.data;
  },

  async create(input: CreateReviewInput): Promise<{ id: string; fullyRatedAt: string | null }> {
    const res = await api.post<{ id: string; fullyRatedAt: string | null }>('/reviews', input);
    return res.data;
  },

  async forProvider(providerId: string): Promise<JobReview[]> {
    const res = await api.get<JobReview[]>(`/reviews/provider/${providerId}`);
    return res.data;
  },
};
