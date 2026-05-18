# Setup Key Vault Template Design

## Problem

`setup-files/setup-node.ps1` contains hard-coded deployment defaults for the relay connection string lookup:

- a concrete Key Vault name
- a concrete Key Vault secret name

Those values should not be committed to a public repository. Moving them into the web app deployment environment should also affect the node setup kit users download from the app.

## Goal

Keep the committed setup files public-safe while allowing each deployment to generate a setup ZIP with its own Key Vault configuration.

## Design

Treat `setup-files/setup-node.ps1` as a template. The committed script will contain placeholders instead of deployment-specific defaults:

```powershell
[string]$KeyVaultName = "__RELAY_KEY_VAULT_NAME__",
[string]$SecretName = "__RELAY_KEY_VAULT_SECRET_NAME__",
```

The setup ZIP route, `app/api/nodes/setup/route.ts`, will read deployment config from:

```txt
RELAY_KEY_VAULT_NAME
RELAY_KEY_VAULT_SECRET_NAME
```

When a user downloads `/api/nodes/setup`, the route will:

1. Read `setup-files/setup-node.ps1`.
2. Replace the placeholders with values from `process.env`.
3. Write the resolved script to a temporary ZIP staging directory.
4. Zip the resolved temporary script with `setup-files/relay-listener.js`.
5. Delete temporary files after creating the response.

The tracked template will remain unchanged by downloads.

## Missing Environment Values

If either deployment environment variable is missing, the ZIP generation will still succeed, but the resolved script will contain an empty default for that parameter. If the user runs setup without passing `-RelayConnectionString`, the script will fail later with the existing Key Vault fetch error path. This keeps misconfiguration visible without blocking users who pass the relay connection string directly.

## Deployment Behavior

Local development uses `.env.local`:

```txt
RELAY_KEY_VAULT_NAME=your-key-vault-name
RELAY_KEY_VAULT_SECRET_NAME=your-secret-name
```

Production deployments set the same variables in the hosting platform's app settings or secrets. The app must be restarted or redeployed after changing those values. Users must download a new setup ZIP after the environment changes; previously downloaded ZIPs will not update.

## Agents Config Sanitization

The tracked `agents.json` should be public-safe and contain no local machine paths or private agent metadata. For this cleanup, it will be reduced to:

```json
{
  "agents": []
}
```

Runtime agent configuration that belongs to a deployment should remain in `.data/config.db` or deployment-local configuration, not in tracked source.

## Tests and Documentation

Add regression coverage that verifies:

- The committed setup script uses placeholders, not real Key Vault names.
- The setup ZIP route reads `RELAY_KEY_VAULT_NAME` and `RELAY_KEY_VAULT_SECRET_NAME`.
- The route replaces placeholders in a temporary script before zipping.
- The tracked `agents.json` is empty.

Update `.env.example` and README to document the new environment variables and the fact that deployment env values are applied when generating a fresh setup ZIP.
