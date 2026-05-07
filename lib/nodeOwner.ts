export function getNodeOwnerFromUserMetadata(userMetadata: unknown): string {
  if (typeof userMetadata !== 'string') return '';

  const match = userMetadata.match(/(?:^|[;\n\r])\s*AzureAccountEmail\s*=\s*([^;\n\r]+)/i);
  return match?.[1]?.trim().toLowerCase() || '';
}

export function getNodeOwnerFromConnectionName(connectionName: string): string {
  const parts = connectionName.split('-');
  if (parts.length >= 3 && parts[0] === 'cpc' && parts[1]) {
    return `${parts[1].toLowerCase()}@microsoft.com`;
  }

  return '';
}

export function getNodeOwner(userMetadata: unknown, connectionName: string): string {
  return getNodeOwnerFromUserMetadata(userMetadata) || getNodeOwnerFromConnectionName(connectionName);
}