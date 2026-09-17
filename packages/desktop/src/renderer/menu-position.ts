export function menuPosition(x: number, y: number, menuWidth: number, menuHeight: number, viewportWidth: number, viewportHeight: number) {
  return {
    x: Math.max(0, Math.min(x, viewportWidth - menuWidth)),
    y: Math.max(0, Math.min(y, viewportHeight - menuHeight))
  };
}
