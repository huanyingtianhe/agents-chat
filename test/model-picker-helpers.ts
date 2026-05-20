import { expect, Page } from '@playwright/test';

export function getModelPickerButton(page: Page, agentId: string) {
  return page.getByRole('button', { name: `Model for ${agentId}` });
}

export async function expectModelPickerSelection(page: Page, agentId: string, label: string) {
  await expect(getModelPickerButton(page, agentId).locator('.agentModelSelectLabel')).toHaveText(label);
}

export async function openModelPicker(page: Page, agentId: string) {
  const picker = getModelPickerButton(page, agentId);
  await picker.click();
  const listbox = page.getByRole('listbox', { name: `Model for ${agentId}` });
  await expect(listbox).toBeVisible();
  return listbox;
}

export async function expectModelOptions(page: Page, agentId: string, labels: string[]) {
  const listbox = await openModelPicker(page, agentId);
  await expect(listbox.locator('.agentModelOptionLabel')).toHaveText(labels);
}

export async function selectModelOption(page: Page, agentId: string, label: string) {
  const listbox = await openModelPicker(page, agentId);
  await listbox.getByRole('option', { name: label, exact: true }).click();
  await expect(page.getByRole('listbox', { name: `Model for ${agentId}` })).toHaveCount(0);
}
