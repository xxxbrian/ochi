import type { ModalProps } from 'react-native';

type Viewport = { width: number; height: number };
type Insets = { top: number; bottom: number; left: number; right: number };
type Rect = { x: number; y: number; width: number; height: number };

export const modalOrientations: NonNullable<ModalProps['supportedOrientations']> = [
  'portrait', 'portrait-upside-down', 'landscape', 'landscape-left', 'landscape-right',
];

export function anchorGeometryKey(width: number, insets: Pick<Insets, 'left' | 'right' | 'top'>) {
  // Keyboard resizing changes height/bottom, not the trigger's horizontal safe area.
  return `${width}:${insets.left}:${insets.right}:${insets.top}`;
}

export function sheetKeyboardLayout(rootHeight: number, screenHeight: number, keyboardHeight: number, top: number, targetHeight: number) {
  'worklet';
  // A native Dialog may already end above the IME; avoid only the remaining overlap.
  const keyboardTop = Math.max(0, screenHeight - Math.max(0, keyboardHeight));
  const bottom = Math.max(0, rootHeight - keyboardTop);
  return { bottom, height: Math.max(0, Math.min(targetHeight, rootHeight - top - bottom)) };
}

export function overlayBounds(viewport: Viewport, insets: Insets, keyboardTop?: number | null) {
  const left = Math.max(0, insets.left) + 12;
  const right = Math.max(left, viewport.width - Math.max(0, insets.right) - 12);
  const top = Math.max(0, insets.top) + 8;
  const bottom = Math.max(top, Math.min(viewport.height - Math.max(0, insets.bottom), keyboardTop ?? Infinity) - 8);
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

export function anchoredMenuLayout(viewport: Viewport, insets: Insets, anchor: Rect, width: number, height: number, align: 'start' | 'end', keyboardTop?: number | null) {
  const safe = overlayBounds(viewport, insets, keyboardTop);
  const menuWidth = Math.min(width, safe.width);
  const menuHeight = Math.min(height, safe.height);
  const left = Math.max(safe.left, Math.min(align === 'end' ? anchor.x + anchor.width - menuWidth : anchor.x, safe.right - menuWidth));
  const below = anchor.y + anchor.height + 6;
  const proposedTop = below + menuHeight <= safe.bottom ? below : anchor.y - menuHeight - 6;
  const top = Math.max(safe.top, Math.min(proposedTop, safe.bottom - menuHeight));
  return { left, top, width: menuWidth, height: menuHeight, maxHeight: safe.height, safe };
}
