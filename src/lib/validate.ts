import { z } from 'zod';
import { round2 } from './money';

export { z };

export const zId = z.string().uuid('Invalid id');
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
export const zMoney = z.coerce.number().finite().min(0).max(1e11).transform(round2);
export const zPositiveMoney = z.coerce.number().finite().positive().max(1e11).transform(round2);
export const zQty = z.coerce
  .number()
  .finite()
  .positive()
  .max(1e9)
  .transform((n) => Math.round(n * 1000) / 1000);
export const zText = (max = 200) => z.string().trim().min(1, 'Required').max(max);
/** Optional free text: empty strings become null. */
export const zOpt = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
export const zOptId = z
  .union([zId, z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null));
export const zBool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);

export const zPaging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  q: z.string().trim().max(100).optional(),
});

export const zRange = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  format: z.enum(['json', 'csv']).default('json'),
});

/** ILIKE pattern for a user search term, with wildcards escaped. */
export const likePattern = (q?: string | null) => (q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null);

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data ?? {});
}

export function formatZodError(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return 'Invalid input';
  const field = issue.path.join('.');
  return field ? `${field}: ${issue.message}` : issue.message;
}
