'use client';

import { useCallback, useRef, useState } from 'react';
import {
  createChatSelectionToken,
  type ChatSelectionToken,
} from './chatSelectionTransitionHelpers';

export type LoadingChatSelection = {
  chatId: string;
  chatName: string;
};

export function useChatSelectionTransition() {
  const sequenceRef = useRef(0);
  const [loadingSelection, setLoadingSelection] = useState<LoadingChatSelection | null>(null);

  const begin = useCallback((chatId: string, chatName: string) => {
    const token = createChatSelectionToken(sequenceRef, chatId);
    setLoadingSelection({ chatId, chatName });
    return token;
  }, []);

  const finish = useCallback((token: ChatSelectionToken) => {
    if (!token.isCurrent()) return false;
    setLoadingSelection(null);
    return true;
  }, []);

  return { loadingSelection, begin, finish };
}
