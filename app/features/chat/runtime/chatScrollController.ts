import { captureReadingAnchor, chatViewport, resolveReadingAnchor, type ReadingAnchor } from '../chatReadingAnchor';
import { clampScrollTop, correctedScrollTop, geometryChanged, isNearBottom, type ScrollGeometry } from '../chatScrollGeometry';

export type ChatScrollSnapshot = {
  following: boolean;
  anchor: ReadingAnchor | null;
  scrollTop: number;
};

export type ChatScrollController = {
  snapshot: () => ChatScrollSnapshot;
  jumpToLatest: () => void;
  suspend: () => void;
  dispose: () => void;
};

export function createChatScrollController(
  container: HTMLElement,
  onBottomChange: (atBottom: boolean) => void,
  initial?: ChatScrollSnapshot,
): ChatScrollController {
  let following = initial?.following ?? true;
  let anchor = initial?.anchor ?? null;
  let lastTop = container.scrollTop;
  let expectedTop: number | null = null;
  let correctionFrame = 0;
  let intentFrame = 0;
  let userIntent = false;
  let suspended = false;
  let disposed = false;
  let multiTouch = false;
  let touchY: number | null = null;
  let scrollbarDrag = false;

  const measure = (): ScrollGeometry => ({
    width: container.clientWidth, height: container.clientHeight, contentHeight: container.scrollHeight,
  });
  let geometry = measure();
  const atBottom = () => isNearBottom(container.scrollTop, container.scrollHeight, container.clientHeight);
  const notify = () => onBottomChange(atBottom());

  function writeTop(top: number) {
    if (Math.abs(container.scrollTop - top) > 0.25) {
      container.scrollTop = top;
      expectedTop = container.scrollTop;
    }
    lastTop = container.scrollTop;
    geometry = measure();
    notify();
  }

  function captureUserPosition() {
    following = atBottom();
    anchor = following ? null : captureReadingAnchor(container);
    geometry = measure();
    lastTop = container.scrollTop;
    expectedTop = null;
    userIntent = false;
    notify();
  }

  function correctLayout() {
    correctionFrame = 0;
    if (disposed || suspended || multiTouch || userIntent || container.clientHeight === 0) return;
    const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
    if (following) writeTop(maximum);
    else if (anchor) {
      const bottom = resolveReadingAnchor(container, anchor);
      if (bottom !== null) {
        writeTop(correctedScrollTop(container.scrollTop, bottom, chatViewport(container).bottom, anchor.bottomGap, maximum));
      } else {
        anchor = captureReadingAnchor(container);
        writeTop(clampScrollTop(container.scrollTop, maximum));
      }
    } else {
      writeTop(clampScrollTop(container.scrollTop, maximum));
      anchor = captureReadingAnchor(container);
    }
  }

  function scheduleCorrection() {
    if (!disposed && !suspended && !multiTouch && !correctionFrame) {
      correctionFrame = requestAnimationFrame(correctLayout);
    }
  }

  function markUserIntent() {
    if (disposed || suspended || multiTouch) return;
    userIntent = true;
    if (correctionFrame) cancelAnimationFrame(correctionFrame);
    correctionFrame = 0;
    if (intentFrame) cancelAnimationFrame(intentFrame);
    intentFrame = requestAnimationFrame(() => {
      intentFrame = 0;
      userIntent = false;
      if (geometryChanged(geometry, measure())) scheduleCorrection();
    });
  }

  function onScroll() {
    if (disposed || suspended || multiTouch) return;
    if (userIntent || scrollbarDrag) {
      captureUserPosition();
      return;
    }
    if (geometryChanged(geometry, measure())) {
      scheduleCorrection();
      return;
    }
    if (expectedTop !== null && Math.abs(container.scrollTop - expectedTop) <= 1) {
      expectedTop = null;
      return;
    }
    if (correctionFrame || Math.abs(container.scrollTop - lastTop) <= 0.25) return;
    captureUserPosition();
  }

  function onWheel(event: WheelEvent) {
    if (!event.ctrlKey && Math.abs(event.deltaY) > Math.abs(event.deltaX)) markUserIntent();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) markUserIntent();
  }

  function onTouchStart(event: TouchEvent) {
    if (event.touches.length > 1) {
      multiTouch = true;
      if (correctionFrame) cancelAnimationFrame(correctionFrame);
      correctionFrame = 0;
    }
    touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
  }

  function onTouchMove(event: TouchEvent) {
    if (event.touches.length > 1) {
      onTouchStart(event);
      return;
    }
    if (!multiTouch && touchY !== null && event.touches.length === 1) {
      if (Math.abs(event.touches[0].clientY - touchY) > 1) markUserIntent();
      touchY = event.touches[0].clientY;
    }
  }

  function onTouchEnd(event: TouchEvent) {
    if (event.touches.length) return;
    touchY = null;
    if (multiTouch) {
      multiTouch = false;
      captureUserPosition();
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.pointerType === 'mouse' && event.target === container) {
      scrollbarDrag = true;
      markUserIntent();
    }
  }
  function onPointerUp() { scrollbarDrag = false; }

  const resizeObserver = new ResizeObserver(scheduleCorrection);
  resizeObserver.observe(container);
  const content = container.querySelector<HTMLElement>('.chatScrollContent');
  if (content) resizeObserver.observe(content);
  const mutationObserver = new MutationObserver(scheduleCorrection);
  mutationObserver.observe(container, { childList: true, subtree: true, characterData: true });
  container.addEventListener('scroll', onScroll, { passive: true });
  container.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('touchstart', onTouchStart, { passive: true });
  container.addEventListener('touchmove', onTouchMove, { passive: true });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });
  container.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  if (initial && !following && !anchor) container.scrollTop = initial.scrollTop;
  correctLayout();

  return {
    snapshot: () => ({ following, anchor, scrollTop: container.scrollTop }),
    jumpToLatest() {
      following = true;
      anchor = null;
      suspended = false;
      userIntent = false;
      correctLayout();
    },
    suspend() {
      suspended = true;
      if (correctionFrame) cancelAnimationFrame(correctionFrame);
      correctionFrame = 0;
    },
    dispose() {
      disposed = true;
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      cancelAnimationFrame(correctionFrame);
      cancelAnimationFrame(intentFrame);
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
    },
  };
}
