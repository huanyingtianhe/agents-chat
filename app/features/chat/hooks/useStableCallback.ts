import { useCallback, useRef } from 'react';

/**
 * Returns a callback whose identity never changes but always invokes the
 * latest version of `fn`. Use this to pass per-render closures to memoized
 * children without busting their `React.memo` shallow comparison.
 *
 * Caveat: do NOT call the returned callback during the render of the
 * component that created it — only from event handlers / effects.
 */
export function useStableCallback<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => TReturn,
): (...args: TArgs) => TReturn {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: TArgs) => ref.current(...args), []);
}
