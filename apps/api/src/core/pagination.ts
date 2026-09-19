import type { PaginationMeta } from '@bidly/types';
import { PAGINATION } from '@bidly/config';

/**
 * Pagination contract shared by every list endpoint.
 * Uses page/limit (simple, cacheable) with server-enforced maximums so a
 * client cannot ask for the entire table in one request.
 */

export interface PageRequest {
  page: number;
  limit: number;
  offset: number;
  sortBy: string | null;
  sortDir: 'asc' | 'desc';
}

export interface PageQueryInput {
  page?: unknown;
  limit?: unknown;
  sortBy?: unknown;
  sortDir?: unknown;
}

export function parsePagination(
  query: PageQueryInput,
  opts?: { defaultLimit?: number; maxLimit?: number },
): PageRequest {
  const maxLimit = opts?.maxLimit ?? PAGINATION.MAX_LIMIT;
  const defaultLimit = opts?.defaultLimit ?? PAGINATION.DEFAULT_LIMIT;

  const rawPage = Number(query.page ?? 1);
  const rawLimit = Number(query.limit ?? defaultLimit);

  const page = Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), maxLimit)
    : defaultLimit;

  const sortDir = query.sortDir === 'asc' ? 'asc' : 'desc';
  const sortBy = typeof query.sortBy === 'string' && /^[a-z_][a-z0-9_]*$/i.test(query.sortBy) ? query.sortBy : null;

  return { page, limit, offset: (page - 1) * limit, sortBy, sortDir };
}

export function buildPage<T>(items: T[], total: number, req: PageRequest): { items: T[]; meta: PaginationMeta } {
  return { items, meta: pageMeta(req, total) };
}

/**
 * Pagination metadata for list endpoints. `total` may be the number of rows on
 * the current page when an exact count is not worth a second query.
 */
export function pageMeta(req: PageRequest, total: number): PaginationMeta {
  const totalPages = Math.max(Math.ceil(total / req.limit), 1);
  return {
    page: req.page,
    limit: req.limit,
    total,
    totalPages,
    hasNext: req.page < totalPages,
    hasPrev: req.page > 1,
  };
}

/**
 * Safe ORDER BY builder. Column names are validated against an allow-list so
 * a client can never inject SQL through a sort parameter.
 */
export function orderByClause(
  req: PageRequest,
  allowed: Record<string, string>,
  fallback: string,
): string {
  if (req.sortBy && allowed[req.sortBy]) {
    return `${allowed[req.sortBy]} ${req.sortDir.toUpperCase()}`;
  }
  return fallback;
}
