import { expect, Page, Locator } from '@playwright/test';

export function filesAgentTrigger(page: Page): Locator {
  return page.locator('.remoteAgentPickerSlot button.themedPickerTrigger');
}

export async function selectFilesAgent(page: Page, agentId: string) {
  const trigger = filesAgentTrigger(page);
  await trigger.click();
  const dropdown = page.locator('.themedPickerDropdown[aria-label="Files agent"]');
  await expect(dropdown).toBeVisible();
  // Match by exact id text in parentheses if present, else by label exact match.
  // Options are rendered as `${label}` from FileTreePanel (no parens), so use exact label.
  await dropdown.locator('button.themedPickerOption').filter({ hasText: agentId }).first().click();
  await expect(dropdown).toHaveCount(0);
}

export async function expectFilesAgentSelected(page: Page, agentId: string) {
  await expect(filesAgentTrigger(page).locator('.themedPickerLabel')).toContainText(agentId);
}
