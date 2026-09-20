type AnchorIdentity = { messageId: string; bottomGap: number };
export type ReadingAnchor = AnchorIdentity & (
  | { kind: 'text'; offset: number }
  | { kind: 'element'; index: number; fraction: number }
);

type Bounds = { top: number; bottom: number; left: number; right: number };
const BODY = '.markdownBody, .userAnswerPart, .thinkingPartText';
const CONTROLS = 'button, [role="button"], .messageActions, .messageHeader, .streamingIndicator';
const MEDIA = 'img, video, canvas, svg';

export function chatViewport(container: HTMLElement): Bounds {
  const rect = container.getBoundingClientRect();
  const top = rect.top + container.clientTop;
  const left = rect.left + container.clientLeft;
  return { top, left, bottom: top + container.clientHeight, right: left + container.clientWidth };
}

function textNodes(message: HTMLElement): Text[] {
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      return parent?.closest(BODY) && !parent.closest(CONTROLS) && node.textContent
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  return nodes;
}

function mediaElements(message: HTMLElement): Element[] {
  return Array.from(message.querySelectorAll(MEDIA))
    .filter((element) => element.closest(BODY) && !element.closest(CONTROLS));
}

function innerBounds(element: Element, container: HTMLElement): Bounds {
  const bounds: Bounds = { top: -Infinity, bottom: Infinity, left: -Infinity, right: Infinity };
  for (let parent: Element | null = element; parent && parent !== container; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.visibility !== 'visible' || style.display === 'none') return { top: 0, bottom: 0, left: 0, right: 0 };
    const rect = parent.getBoundingClientRect();
    if (/hidden|clip|auto|scroll/.test(style.overflowY)) {
      bounds.top = Math.max(bounds.top, rect.top + parent.clientTop);
      bounds.bottom = Math.min(bounds.bottom, rect.top + parent.clientTop + parent.clientHeight);
    }
    if (/hidden|clip|auto|scroll/.test(style.overflowX)) {
      bounds.left = Math.max(bounds.left, rect.left + parent.clientLeft);
      bounds.right = Math.min(bounds.right, rect.left + parent.clientLeft + parent.clientWidth);
    }
  }
  return bounds;
}

function characterRect(node: Text, offset: number): DOMRect {
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + 1);
  return range.getBoundingClientRect();
}

function intersects(rect: DOMRect, bounds: Bounds): boolean {
  return rect.height > 0 && rect.width > 0
    && rect.bottom > bounds.top && rect.top < bounds.bottom
    && rect.right > bounds.left && rect.left < bounds.right;
}

function visibleOffset(node: Text, bounds: Bounds, firstOnLine: boolean, partial = false): number {
  let low = 0;
  let high = node.length - 1;
  let end = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const rect = characterRect(node, middle);
    if (partial ? rect.top < bounds.bottom : rect.bottom <= bounds.bottom + 0.01) {
      end = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  const rtl = node.parentElement && getComputedStyle(node.parentElement).direction === 'rtl';
  while (end >= 0) {
    while (end >= 0 && /\s/.test(node.data[end])) end--;
    if (end < 0) break;
    const last = characterRect(node, end);
    if (last.bottom <= bounds.top) break;
    low = 0;
    high = end;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (characterRect(node, middle).bottom < last.bottom - 0.1) low = middle + 1;
      else high = middle;
    }
    const start = low;
    high = end;
    let selected = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const rect = characterRect(node, middle);
      if (firstOnLine) {
        if (rtl ? rect.left < bounds.right : rect.right > bounds.left) {
          selected = middle;
          high = middle - 1;
        } else low = middle + 1;
      } else if (rtl ? rect.right > bounds.left : rect.left < bounds.right) {
        selected = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    while (selected >= start && selected <= end && /\s/.test(node.data[selected])) selected += firstOnLine ? 1 : -1;
    if (selected >= start && selected <= end && intersects(characterRect(node, selected), bounds)) return selected;
    end = start - 1;
  }
  return -1;
}

export function captureReadingAnchor(container: HTMLElement): ReadingAnchor | null {
  const viewport = chatViewport(container);
  let chosen: ReadingAnchor | null = null;
  let lowest = -Infinity;
  let partialAnchor: ReadingAnchor | null = null;
  let fallback: ReadingAnchor | null = null;
  const messages = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'));
  for (const message of messages) {
    const messageId = message.dataset.messageId;
    const messageRect = message.getBoundingClientRect();
    if (!messageId || !intersects(messageRect, viewport)) continue;
    const fallbackY = Math.min(messageRect.bottom, viewport.bottom);
    fallback = {
      kind: 'element', messageId, index: -1,
      fraction: (fallbackY - messageRect.top) / messageRect.height,
      bottomGap: viewport.bottom - fallbackY,
    };
    let baseOffset = 0;
    for (const node of textNodes(message)) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (!node.data.trim()) { baseOffset += node.length; continue; }
      const clip = innerBounds(parent, container);
      const bounds = {
        top: Math.max(viewport.top, clip.top), bottom: Math.min(viewport.bottom, clip.bottom),
        left: Math.max(viewport.left, clip.left), right: Math.min(viewport.right, clip.right),
      };
      const range = document.createRange();
      range.selectNodeContents(node);
      if (intersects(range.getBoundingClientRect(), bounds)) {
        const firstOnLine = !!parent.closest('pre');
        const offset = visibleOffset(node, bounds, firstOnLine);
        if (offset >= 0) {
          const rect = characterRect(node, offset);
          if (intersects(rect, bounds) && rect.bottom >= lowest) {
            lowest = rect.bottom;
            chosen = { kind: 'text', messageId, offset: baseOffset + offset, bottomGap: viewport.bottom - rect.bottom };
          }
        } else {
          const partialOffset = visibleOffset(node, bounds, firstOnLine, true);
          if (partialOffset >= 0) {
            partialAnchor = {
              kind: 'text', messageId, offset: baseOffset + partialOffset,
              bottomGap: viewport.bottom - characterRect(node, partialOffset).bottom,
            };
          }
        }
      }
      baseOffset += node.length;
    }
    mediaElements(message).forEach((element, index) => {
      const rect = element.getBoundingClientRect();
      const clip = innerBounds(element, container);
      if (!intersects(rect, viewport) || !intersects(rect, clip)) return;
      const bottom = Math.min(rect.bottom, viewport.bottom, clip.bottom);
      if (bottom < lowest) return;
      lowest = bottom;
      chosen = {
        kind: 'element', messageId, index,
        fraction: Math.max(0, Math.min(1, (bottom - rect.top) / rect.height)),
        bottomGap: viewport.bottom - bottom,
      };
    });
  }
  return chosen ?? partialAnchor ?? fallback;
}

export function resolveReadingAnchor(container: HTMLElement, anchor: ReadingAnchor): number | null {
  const message = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
    .find((element) => element.dataset.messageId === anchor.messageId);
  if (!message) return null;
  if (anchor.kind === 'element') {
    const element = anchor.index < 0 ? message : mediaElements(message)[anchor.index];
    if (element) {
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) return rect.top + rect.height * anchor.fraction;
    }
  } else {
    let offset = anchor.offset;
    for (const node of textNodes(message)) {
      if (offset < node.length && node.parentElement) {
        const rect = characterRect(node, offset);
        const clip = innerBounds(node.parentElement, container);
        if (intersects(rect, clip) && rect.bottom <= clip.bottom + 0.01) return rect.bottom;
        break;
      }
      offset -= node.length;
    }
  }
  // Explicit collapse/removal inside a surviving message keeps its visible boundary.
  const rect = message.getBoundingClientRect();
  return rect.height > 0 ? rect.bottom : null;
}
