// Service-to-service auth: the backend presents X-API-Key = PINE_RUNNER_KEY.
// Constant-time compare; fails closed in production when the key is unset.
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';

export function keysMatch(presented, expected) {
  if (typeof presented !== 'string' || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function requireServiceKey(request, reply, done) {
  const expected = config.serviceKey;
  if (!expected) {
    if (config.isProduction) {
      request.log.error('PINE_RUNNER_KEY is not configured in production; refusing request');
      reply.code(500).send({ detail: 'Service misconfigured' });
      return;
    }
    request.log.warn('PINE_RUNNER_KEY unset; allowing request (dev mode)');
    done();
    return;
  }
  if (!keysMatch(request.headers['x-api-key'], expected)) {
    reply.code(401).send({ detail: 'Invalid service key' });
    return;
  }
  done();
}
