/**
 * Local stand-in for @appdeploy/client, used only when MONOLITH_LOCAL_CLIENT=1
 * (GitHub Actions build, `npm run dev:local`). In AppDeploy the real client is
 * injected by the platform and this file is not used.
 * Sign-in is unavailable locally, so financial data is never shown here.
 */
async function request(method: string, url: string, data?: unknown): Promise<{ data: any }> {
  const response = await fetch(url, {
    method,
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof body?.message === 'string' ? body.message : 'API request failed');
  }
  return { data: body };
}

export const api = {
  get: (url: string) => request('GET', url),
  post: (url: string, data?: unknown) => request('POST', url, data),
  put: (url: string, data?: unknown) => request('PUT', url, data),
  delete: (url: string) => request('DELETE', url),
};

export const auth = {
  isSignedIn: () => false,
  getUser: async () => null,
  getAccessToken: async () => null,
  signOut: async () => undefined,
  signIn: async (): Promise<never> => {
    throw Object.assign(new Error('Вход доступен только в развёрнутом приложении AppDeploy.'), {
      code: 'auth_error',
    });
  },
};
