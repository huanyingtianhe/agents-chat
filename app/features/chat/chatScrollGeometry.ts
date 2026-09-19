export type ScrollGeometry = {
  width: number;
  height: number;
  contentHeight: number;
};

export function clampScrollTop(value: number, maximum: number): number {
  return Math.max(0, Math.min(value, Math.max(0, maximum)));
}

export function isNearBottom(top: number, height: number, viewport: number): boolean {
  return height - top - viewport <= 4;
}

export function geometryChanged(previous: ScrollGeometry, next: ScrollGeometry): boolean {
  return previous.width !== next.width
    || previous.height !== next.height
    || previous.contentHeight !== next.contentHeight;
}

export function isLayoutScroll(previousTop: number, currentTop: number, maximum: number): boolean {
  return Math.abs(currentTop - clampScrollTop(previousTop, maximum)) <= 1;
}

export function correctedScrollTop(
  top: number,
  pointBottom: number,
  viewportBottom: number,
  bottomGap: number,
  maximum: number,
): number {
  return clampScrollTop(top + pointBottom - viewportBottom + bottomGap, maximum);
}
