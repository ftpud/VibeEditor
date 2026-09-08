/** Keep synchronous dialog return values intact while repairing Electron focus. */
export function installNativeDialogFocusRecovery(target: Window): () => void {
  const restore = target.desktop?.restoreInputFocus;
  if (!restore) return () => undefined;
  const originalConfirm = target.confirm;
  const originalAlert = target.alert;
  const recover = () => { void restore().catch(() => { /* The window may be closing. */ }); };
  const confirm: Window["confirm"] = (message) => {
    try { return originalConfirm.call(target, message); }
    finally { recover(); }
  };
  const alert: Window["alert"] = (message) => {
    try { originalAlert.call(target, message); }
    finally { recover(); }
  };
  target.confirm = confirm;
  target.alert = alert;
  return () => {
    if (target.confirm === confirm) target.confirm = originalConfirm;
    if (target.alert === alert) target.alert = originalAlert;
  };
}
