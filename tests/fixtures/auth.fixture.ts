import { test as base, expect } from 'e2e';

export interface TestCredentials {
  email: string;
  password: string;
}

export interface AuthFixtures {
  authAccounts: {
    member: TestCredentials;
    admin: TestCredentials;
  };
  loginAsMember: () => Promise<void>;
  loginAsAdmin: () => Promise<void>;
  logout: () => Promise<void>;
}

const accounts = {
  member: {
    email: process.env.E2E_USER_EMAIL ?? 'qa-member@example.com',
    password: process.env.E2E_USER_PASSWORD ?? 'SuperSecretPassword123!',
  },
  admin: {
    email: process.env.E2E_ADMIN_EMAIL ?? 'qa-admin@example.com',
    password: process.env.E2E_ADMIN_PASSWORD ?? 'AdminSecretPassword123!',
  },
};

/**
 * Extended `test` instance providing reusable authentication and session helpers
 * that combine deterministic checks with agentic UI interactions.
 */
export const test = base.extend<AuthFixtures>({
  authAccounts: async ({}, use) => {
    await use(accounts);
  },

  loginAsMember: async ({ app, agent, screen }, use) => {
    const login = async () => {
      await app.open('/login');
      await agent.act(
        `Sign in using email "${accounts.member.email}" and password "${accounts.member.password}"`
      );
      await agent.assert('the user dashboard or workspace home screen is loaded');
      await expect(screen.getByRole('navigation')).toBeVisible();
    };

    await use(login);
  },

  loginAsAdmin: async ({ app, agent, screen }, use) => {
    const login = async () => {
      await app.open('/login');
      await agent.act(
        `Sign in using email "${accounts.admin.email}" and password "${accounts.admin.password}"`
      );
      await agent.assert('the authenticated admin workspace view is visible');
      await expect(screen.getByRole('navigation')).toBeVisible();
    };

    await use(login);
  },

  logout: async ({ agent, screen }, use) => {
    const performLogout = async () => {
      await agent.act('open the user profile menu and click Sign Out or Log Out');
      await agent.assert('the login form is visible and the user is signed out');
      await expect(screen.getByRole('button', { name: /sign in|log in/i })).toBeVisible();
    };

    await use(performLogout);
  },
});

export { expect };
