import { useEffect } from "react";

const modalSelector = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Keeps the topmost renderer modal keyboard-contained and restores its invoker. */
export function ModalFocusManager() {
  useEffect(() => {
    let active: HTMLElement | undefined;
    let restoreTo: HTMLElement | undefined;
    const sync = () => {
      const next = [...document.querySelectorAll<HTMLElement>(modalSelector)].at(-1);
      if (next === active) return;
      if (!next) {
        const target = restoreTo;
        active = undefined; restoreTo = undefined;
        if (target?.isConnected) target.focus();
        return;
      }
      if (!active) restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      active = next;
      queueMicrotask(() => {
        if (active !== next || next.contains(document.activeElement)) return;
        (next.querySelector<HTMLElement>("[autofocus]") ?? next.querySelector<HTMLElement>(focusableSelector))?.focus();
      });
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    const contain = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !active) return;
      const controls = [...active.querySelectorAll<HTMLElement>(focusableSelector)].filter((item) => !item.closest('[hidden], [aria-hidden="true"]'));
      if (!controls.length) { event.preventDefault(); active.focus(); return; }
      const first = controls[0]!; const last = controls.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !active.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !active.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", contain, true);
    return () => { observer.disconnect(); document.removeEventListener("keydown", contain, true); };
  }, []);
  return null;
}
