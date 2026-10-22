import {
  error,
  requireAdminEmailAllowlist,
  secrets,
  type RouterContext,
  type RouterResponse,
} from '@appdeploy/sdk';
import { parseEmailList } from './email-list';

/**
 * Access list for financial data. Configured out-of-band as the app secret
 * ALLOWED_EMAILS (comma- or newline-separated emails). Fails closed: when the
 * secret is missing or empty, nobody gets the data.
 */
export const ACCESS_SECRET = 'ALLOWED_EMAILS';

export async function loadAllowedEmails(): Promise<string[]> {
  const names = await secrets.listSecretNames();
  if (!names.includes(ACCESS_SECRET)) return [];
  return parseEmailList(await secrets.readSecret(ACCESS_SECRET));
}

/** Use after requireAuth(): only users on the access list pass. */
export function requireAccessList() {
  return async (ctx: RouterContext): Promise<RouterResponse | void> => {
    let allowed: string[];
    try {
      allowed = await loadAllowedEmails();
    } catch (cause) {
      console.error('Access list could not be read', cause);
      return error('Список доступа временно недоступен.', 503);
    }
    if (allowed.length === 0) {
      return error('Доступ к данным ещё не настроен владельцем приложения.', 403);
    }
    return requireAdminEmailAllowlist(allowed)(ctx);
  };
}
