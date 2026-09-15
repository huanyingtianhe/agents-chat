export type MutableSequence = {
  current: number;
};

export type ChatSelectionToken = {
  chatId: string;
  isCurrent: () => boolean;
  invalidate: () => void;
};

export function createChatSelectionToken(
  sequenceRef: MutableSequence,
  chatId: string,
): ChatSelectionToken {
  const sequence = ++sequenceRef.current;
  return {
    chatId,
    isCurrent: () => sequenceRef.current === sequence,
    invalidate: () => {
      if (sequenceRef.current === sequence) sequenceRef.current++;
    },
  };
}
