import { useLayoutEffect, useRef, type HTMLAttributes, type KeyboardEvent } from "react";

/** Shared sizing, dismissal and keyboard navigation for pointer-anchored menus. */
export function ContextMenu({ children, onKeyDown, ...props }: HTMLAttributes<HTMLDivElement>) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = root.current;
    if (!menu) return;
    const nested = !!menu.closest(".context-submenu");
    const owner = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (!nested) {
      const rect = menu.getBoundingClientRect();
      if (rect.width && rect.height) {
        menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - rect.height - 8))}px`;
      }
      menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || nested) return;
      event.preventDefault();
      (menu.closest(".context-menu-layer") ?? document).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      if (owner?.isConnected) owner.focus();
    };
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("keydown", escape); if (!nested && menu.contains(document.activeElement) && owner?.isConnected) owner.focus(); };
  }, []);
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].filter((button) => !button.closest(".context-submenu") || button.closest(".context-menu") === event.currentTarget);
    if (!controls.length) return;
    event.preventDefault(); event.stopPropagation();
    const current = controls.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
    controls[next]?.focus();
  };
  return <div {...props} ref={root} role="menu" onKeyDown={navigate}>{children}</div>;
}
