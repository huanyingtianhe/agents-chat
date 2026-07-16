import { expect, Page, Locator } from '@playwright/test';

export function filesAgentTrigger(page: Page): Locator {
  return page.locator('.remoteAgentPickerSlot button.themedPickerTrigger');
}

export async function selectFilesAgent(page: Page, agentId: string) {
  const trigger = filesAgentTrigger(page);
  await trigger.click();
  const dropdown = page.locator('.themedPickerDropdown[aria-label="Files agent"]');
  await expect(dropdown).toBeVisible();
  await dropdown.locator(`button.themedPickerOption[data-value="${agentId}"]`).click();
  await expect(dropdown).toHaveCount(0);
}

export async function expectFilesAgentSelected(page: Page, agentId: string) {
  await expect(filesAgentTrigger(page)).toHaveAttribute('data-value', agentId);
}
