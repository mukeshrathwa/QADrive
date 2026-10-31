import { test, expect } from './fixtures/auth.fixture';
import { AppRoutes, dismissBlockingOverlays } from './helpers/navigation.helper';

test.describe('Authentication & Session Flows', () => {
  test('member signs in with valid credentials and views dashboard', async ({
    app,
    agent,
    screen,
    authAccounts,
  }) => {
    // 1. Navigate via app.open(...)
    await app.open(AppRoutes.login);
    await dismissBlockingOverlays(agent);

    // 2. Deterministic structural DOM check before acting
    await expect(screen.getByRole('heading', { name: /sign in|welcome back/i })).toBeVisible();

    // 3. Agentic natural-language exploration with agent.act(...)
    await agent.act(
      `Fill in the email field with "${authAccounts.member.email}", enter password "${authAccounts.member.password}", and submit the login form`
    );

    // 4. Semantic verification with agent.assert(...)
    await agent.assert(
      'The user is redirected to the main dashboard and no authentication error alerts are displayed'
    );

    // 5. Deterministic structural DOM check after login
    await expect(screen.getByRole('navigation')).toBeVisible();
    await expect(screen.getByRole('main')).toContainText(/dashboard|overview/i);
  });

  test('displays validation error when signing in with invalid password', async ({
    app,
    agent,
    screen,
    authAccounts,
  }) => {
    await app.open(AppRoutes.login);

    await agent.act(
      `Attempt to log in with email "${authAccounts.member.email}" and an incorrect password "WrongPassword999!"`
    );

    await agent.assert(
      'An error message is shown explaining that the email or password is invalid'
    );

    await expect(screen.getByRole('alert')).toBeVisible();
  });
});
