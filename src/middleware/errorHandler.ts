import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../utils/errors.js';

/** Central error handler — converts AppError to structured JSON. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    // Zod / validation errors from Fastify schema validation
    if (err.validation) {
      reply.status(400).send({ error: 'VALIDATION_ERROR', message: err.message });
      return;
    }
    req.log.error(err, 'Unhandled error');
    reply.status(500).send({ error: 'INTERNAL_ERROR', message: 'Internal server error' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'NOT_FOUND', message: `Route not found: ${req.method} ${req.url}` });
  });
}
