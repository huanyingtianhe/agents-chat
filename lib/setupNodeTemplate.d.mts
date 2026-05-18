export declare const SETUP_KEY_VAULT_NAME_PLACEHOLDER: '__RELAY_KEY_VAULT_NAME__';
export declare const SETUP_KEY_VAULT_SECRET_PLACEHOLDER: '__RELAY_KEY_VAULT_SECRET_NAME__';
export declare const SETUP_SUBSCRIPTION_ID_PLACEHOLDER: '__RELAY_SUBSCRIPTION_ID__';
export declare const SETUP_RESOURCE_GROUP_PLACEHOLDER: '__RELAY_RESOURCE_GROUP__';

export interface SetupNodeTemplateEnv {
  RELAY_KEY_VAULT_NAME?: string;
  RELAY_KEY_VAULT_SECRET_NAME?: string;
  RELAY_SUBSCRIPTION_ID?: string;
  RELAY_RESOURCE_GROUP?: string;
}

export declare function escapePowerShellDoubleQuotedString(value: string): string;
export declare function renderSetupNodeScript(source: string, env?: SetupNodeTemplateEnv): string;
