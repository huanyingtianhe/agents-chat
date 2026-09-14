'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { readJsonApiResponse, StorageUnavailableError } from '../chatApi';

export type ChatSearchResult = {
  id: string;
  name: string;
  ts: number;
  agentId?: string;
};

export function useChatSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatSearchResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [storageError, setStorageError] = useState<StorageUnavailableError | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      setResults(null);
      setLoading(false);
      setStorageError(null);
      return;
    }
    setLoading(true);
    try {
      const data = await readJsonApiResponse(await fetch(`/api/chats?search=${encodeURIComponent(trimmed)}`));
      if (data.ok && Array.isArray(data.chats)) setResults(data.chats);
      setStorageError(null);
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        setStorageError(error);
      } else {
        console.error('Failed to search stored chats', error);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    timerRef.current = setTimeout(() => void search(trimmed), 300);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, search]);

  return {
    query,
    setQuery,
    results,
    loading,
    storageError,
    retry: () => search(query),
  };
}
