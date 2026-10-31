import { test, expect } from './fixtures/auth.fixture';
import { AppRoutes } from './helpers/navigation.helper';

test.describe('Workspace Billing & Plan Upgrade', () => {
  test('a member upgrades workspace subscription to the Pro plan', async ({
    app,
    agent,
    screen,
    loginAsMember,
  }) => {
    // Authenticate using reusable fixture
    await loginAsMember();

    // 1. Navigate to billing settings via app.open(...)
    await app.open(AppRoutes.billing);

    // 2. Deterministic structural DOM check on initial billing page
    await expect(
      screen.getByRole('heading', { name: /billing|subscription/i })
    ).toBeVisible();

    // 3. Agentic natural-language exploration with agent.act(...)
    await agent.act('upgrade the workspace to the Pro plan with monthly billing');

    // 4. Semantic verification with agent.assert(...)
    await agent.assert(
      'the invoice preview shows a prorated amount and confirms the Pro tier features'
    );

    // 5. Confirm upgrade via agentic action and verify deterministic DOM status badge
    await agent.act('confirm the subscription upgrade');
    await expect(screen.getByRole('status')).toContainText('Pro');
  });
});
