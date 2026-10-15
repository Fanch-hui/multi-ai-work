import { randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName = 'ma_work_web_session';
const matches = (actual: string, expected: string) => {
  const left = Buffer.from(actual), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

export function createWebSession() {
  let launchCode: string | undefined = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 5 * 60_000;
  let session: string | undefined;
  const launchUrl = `http://127.0.0.1:5173/#web-launch=${launchCode}`;
  return {
    launchUrl,
    exchange(code: string): string | undefined {
      if (!launchCode || Date.now() >= expiresAt || !matches(code, launchCode)) return;
      launchCode = undefined;
      session = randomBytes(32).toString('base64url');
      return `${cookieName}=${session}; Path=/api; HttpOnly; SameSite=Strict`;
    },
    authorized(cookies: string | undefined): boolean {
      if (!session || !cookies) return false;
      const cookie = cookies.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
      return !!cookie && matches(cookie.slice(cookieName.length + 1), session);
    },
  };
}
