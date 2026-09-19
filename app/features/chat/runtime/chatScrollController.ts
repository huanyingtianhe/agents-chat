import { captureReadingAnchor, chatViewport, resolveReadingAnchor, type ReadingAnchor } from '../chatReadingAnchor';
import { clampScrollTop, correctedScrollTop, geometryChanged, isIndependentScroll, isNearBottom, type ScrollGeometry } from '../chatScrollGeometry';

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
  let jumping = false;

  const measure = (): ScrollGeometry => ({
    width: container.clientWidth, height: container.clientHeight, contentHeight: container.scrollHeight,
  });
  let geometry = measure();
  const atBottom = () => isNearBottom(container.scrollTop, container.scrollHeight, container.clientHeight);
  const notify = () => onBottomChange(jumping || atBottom());

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
    if (correctionFrame) cancelAnimationFrame(correctionFrame);
    correctionFrame = 0;
    following = atBottom();
    jumping = false;
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
    // WebKit may deliver the scroll event after the resize callback.
    if (!jumping && isIndependentScroll(geometry, measure(), lastTop, container.scrollTop)) {
      captureUserPosition();
      return;
    }
    jumping = false;
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
    if (jumping) {
      jumping = false;
      container.scrollTo({ top: container.scrollTop, behavior: 'instant' });
      captureUserPosition();
    }
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
    const current = measure();
    if (geometryChanged(geometry, current)) {
      if (isIndependentScroll(geometry, current, lastTop, container.scrollTop)) captureUserPosition();
      else scheduleCorrection();
      return;
    }
    if (jumping) {
      lastTop = container.scrollTop;
      if (atBottom()) jumping = false;
      notify();
      return;
    }
    if (expectedTop !== null && Math.abs(container.scrollTop - expectedTop) <= 1) {
      expectedTop = null;
      return;
    }
    if (Math.abs(container.scrollTop - lastTop) <= 0.25) return;
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
    touchY = event.touches.length === 1 && event.target instanceof Node && container.contains(event.target)
      ? event.touches[0].clientY : null;
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
  window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
  container.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointerup', onPointerUp, { passive: true });
  window.addEventListener('pointercancel', onPointerUp, { passive: true });
  window.addEventListener('blur', onPointerUp);
  if (initial && !following && !anchor) container.scrollTop = initial.scrollTop;
  correctLayout();

  return {
    snapshot: () => ({ following, anchor, scrollTop: container.scrollTop }),
    jumpToLatest() {
      following = true;
      anchor = null;
      suspended = false;
      userIntent = false;
      if (correctionFrame) cancelAnimationFrame(correctionFrame);
      correctionFrame = 0;
      expectedTop = null;
      jumping = !atBottom();
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      notify();
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
      window.removeEventListener('touchstart', onTouchStart, true);
      window.removeEventListener('touchmove', onTouchMove, true);
      window.removeEventListener('touchend', onTouchEnd, true);
      window.removeEventListener('touchcancel', onTouchEnd, true);
      container.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('blur', onPointerUp);
    },
  };
}
