/** An error whose message is safe to show to the person who made the request. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorised = (message = 'Please log in') =>
  new AppError(401, 'unauthorised', message);
export const forbidden = (message = 'You do not have access to this') =>
  new AppError(403, 'forbidden', message);
/** Also used when something exists but belongs to another organisation: never reveal it exists */
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
