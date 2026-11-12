import type { FastifyReply, FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../utils/errors.js';

/**
 * Optional API-key authentication.
 * When API_KEY is configured, mutating routes require
 * `Authorization: Bearer <key>`. Read-only stream endpoints stay public.
 */
export function apiKeyAuth(apiKey: string | undefined) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!apiKey) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (token !== apiKey) throw new UnauthorizedError('Invalid or missing API key');
  };
}

/** Lavalink v4 style auth: `Authorization: <password>` (no Bearer prefix). */
export function lavalinkAuth(password: string) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (token !== password) throw new UnauthorizedError('Invalid Lavalink password');
  };
}
