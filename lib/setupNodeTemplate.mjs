export const SETUP_KEY_VAULT_NAME_PLACEHOLDER = '__RELAY_KEY_VAULT_NAME__';
export const SETUP_KEY_VAULT_SECRET_PLACEHOLDER = '__RELAY_KEY_VAULT_SECRET_NAME__';
export const SETUP_SUBSCRIPTION_ID_PLACEHOLDER = '__RELAY_SUBSCRIPTION_ID__';
export const SETUP_RESOURCE_GROUP_PLACEHOLDER = '__RELAY_RESOURCE_GROUP__';

export function escapePowerShellDoubleQuotedString(value) {
  return value
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(/"/g, '`"');
}

export function renderSetupNodeScript(source, env = process.env) {
  const keyVaultName = escapePowerShellDoubleQuotedString(env.RELAY_KEY_VAULT_NAME ?? '');
  const secretName = escapePowerShellDoubleQuotedString(env.RELAY_KEY_VAULT_SECRET_NAME ?? '');
  const subscriptionId = escapePowerShellDoubleQuotedString(env.RELAY_SUBSCRIPTION_ID ?? '');
  const resourceGroup = escapePowerShellDoubleQuotedString(env.RELAY_RESOURCE_GROUP ?? '');
  return source
    .replaceAll(SETUP_KEY_VAULT_NAME_PLACEHOLDER, () => keyVaultName)
    .replaceAll(SETUP_KEY_VAULT_SECRET_PLACEHOLDER, () => secretName)
    .replaceAll(SETUP_SUBSCRIPTION_ID_PLACEHOLDER, () => subscriptionId)
    .replaceAll(SETUP_RESOURCE_GROUP_PLACEHOLDER, () => resourceGroup);
}
