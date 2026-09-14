export async function nodesApi(
  body: Record<string, unknown>,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data: Record<string, any> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!response.ok) throw new Error(text);
      throw new Error('Nodes response was not valid JSON');
    }
  }
  if (!response.ok || data.ok === false) {
    throw new Error(
      typeof data.error === 'string' && data.error
        ? data.error
        : text || `Nodes request failed (${response.status})`,
    );
  }
  return data;
}
