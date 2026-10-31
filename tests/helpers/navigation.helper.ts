import { expect, type App, type Agent, type Screen } from 'e2e';

/**
 * Common application routes centralized for maintainability.
 */
export const AppRoutes = {
  home: '/',
  login: '/login',
  dashboard: '/dashboard',
  billing: '/settings/billing',
  profile: '/settings/profile',
  catalog: '/products',
  checkout: '/checkout',
} as const;

export type RouteKey = keyof typeof AppRoutes;

/**
 * Helper to navigate to a known route and verify the page heading deterministically.
 */
export async function navigateAndVerifyHeading(
  app: App,
  screen: Screen,
  path: string,
  expectedHeading: string | RegExp
): Promise<void> {
  await app.open(path);
  const heading = screen.getByRole('heading', { name: expectedHeading });
  await expect(heading).toBeVisible();
}

/**
 * Helper to dismiss cookie banners, onboarding modals, or promotional popups
 * using the AI agent before running core test assertions.
 */
export async function dismissBlockingOverlays(agent: Agent): Promise<void> {
  await agent.act(
    'If a cookie consent banner, promotional modal, or onboarding tooltip is blocking the screen, dismiss or close it; otherwise do nothing.'
  );
}
