import { test, expect } from './fixtures/auth.fixture';
import { AppRoutes, dismissBlockingOverlays } from './helpers/navigation.helper';

test.describe('E-Commerce Search & Checkout Journey', () => {
  test('user searches for a product, adds it to cart, and verifies order summary', async ({
    app,
    agent,
    screen,
  }) => {
    // 1. Navigate to product catalog via app.open(...)
    await app.open(AppRoutes.catalog);
    await dismissBlockingOverlays(agent);

    // 2. Deterministic check for search input role
    await expect(screen.getByRole('searchbox')).toBeVisible();

    // 3. Agentic exploration: search, filter, and add item to cart
    await agent.act(
      'Search for "Mechanical Keyboard", select the first in-stock result, and add it to the shopping cart'
    );

    // 4. Semantic verification of cart drawer/notification
    await agent.assert(
      'The shopping cart indicator shows 1 item and displays the Mechanical Keyboard with a valid price'
    );

    // 5. Proceed to checkout and verify structural DOM elements
    await agent.act('Proceed to the checkout screen');
    await agent.assert(
      'The order summary lists the Mechanical Keyboard, subtotal, estimated tax, and total amount'
    );

    await expect(
      screen.getByRole('heading', { name: /checkout|order summary/i })
    ).toBeVisible();
    await expect(
      screen.getByRole('button', { name: /place order|pay now|complete purchase/i })
    ).toBeEnabled();
  });
});
