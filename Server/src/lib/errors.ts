export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'error',
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new HttpError(400, message, 'bad_request');
export const unauthorized = (message = 'Please sign in') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new HttpError(403, message, 'forbidden');
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`, 'not_found');
export const conflict = (message: string) => new HttpError(409, message, 'conflict');

const UNIQUE_HINTS: [RegExp, string][] = [
  [/sku/, 'SKU already exists'],
  [/barcode/, 'Barcode already exists'],
  [/email/, 'Email address is already in use'],
  [/slug/, 'This business ID is already taken'],
  [/period/, 'Payroll for this period already exists'],
  [/memberships_tenant_id_user_id/, 'This user is already a member of the business'],
  [/code/, 'Code already exists'],
  [/name/, 'Name already exists'],
];

/** Maps PostgreSQL errors to safe, user-facing HTTP errors. */
export function fromPgError(err: { code?: string; constraint?: string; message?: string }): HttpError | null {
  switch (err.code) {
    case '23505': {
      const hint = UNIQUE_HINTS.find(([re]) => re.test(err.constraint ?? ''));
      return conflict(hint ? hint[1] : 'A record with the same value already exists');
    }
    case '23503':
      // Composite (tenant_id, id) foreign keys make cross-tenant references land here.
      return badRequest('A referenced record does not exist');
    case '23514':
    case '23502':
      return badRequest('The submitted values violate a business rule');
    case '42501':
      return forbidden('Access denied');
    case '22P02':
      return badRequest('Invalid identifier or value');
    case '40001':
    case '40P01':
      return conflict('The system was busy with a conflicting change, please retry');
    case 'P0001':
      return badRequest(err.message ?? 'Business rule violated');
    default:
      return null;
  }
}
