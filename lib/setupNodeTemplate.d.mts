export declare const SETUP_KEY_VAULT_NAME_PLACEHOLDER: '__RELAY_KEY_VAULT_NAME__';
export declare const SETUP_KEY_VAULT_SECRET_PLACEHOLDER: '__RELAY_KEY_VAULT_SECRET_NAME__';
export declare const SETUP_SUBSCRIPTION_ID_PLACEHOLDER: '__RELAY_SUBSCRIPTION_ID__';
export declare const SETUP_RESOURCE_GROUP_PLACEHOLDER: '__RELAY_RESOURCE_GROUP__';
export declare const SETUP_DEFAULT_LAUNCHER_PLACEHOLDER: '__SETUP_DEFAULT_LAUNCHER__';

export type SetupLauncher = 'copilot' | 'agency';
export declare const SUPPORTED_LAUNCHERS: ReadonlyArray<SetupLauncher>;
export declare const DEFAULT_LAUNCHER: SetupLauncher;
export declare function normalizeLauncher(value: string | null | undefined): SetupLauncher;

export interface SetupNodeTemplateEnv {
  RELAY_KEY_VAULT_NAME?: string;
  RELAY_KEY_VAULT_SECRET_NAME?: string;
  RELAY_SUBSCRIPTION_ID?: string;
  RELAY_RESOURCE_GROUP?: string;
  [key: string]: string | undefined;
}

export interface SetupNodeTemplateOptions {
  launcher?: SetupLauncher | string | null;
}

export declare function escapePowerShellDoubleQuotedString(value: string): string;
export declare function renderSetupNodeScript(
  source: string,
  env?: SetupNodeTemplateEnv,
  options?: SetupNodeTemplateOptions,
): string;
