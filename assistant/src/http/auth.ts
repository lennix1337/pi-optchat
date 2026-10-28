import { createHash, timingSafeEqual } from 'node:crypto';

export function authenticate(header: string | undefined, token: string): boolean {
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(token)) && supplied.length > 0;
}
