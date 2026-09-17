import { describe, expect, it, vi } from "vitest";
import { installNativeDialogFocusRecovery } from "./native-dialog-focus";

describe("native dialog focus recovery", () => {
  it.each([true, false])("preserves confirmation result %s and restores focus after dismissal", (choice) => {
    const restoreInputFocus = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.fn(() => { expect(restoreInputFocus).not.toHaveBeenCalled(); return choice; });
    const target = { confirm, alert: vi.fn(), desktop: { restoreInputFocus } } as unknown as Window;
    const uninstall = installNativeDialogFocusRecovery(target);
    expect(target.confirm("Delete? ")).toBe(choice);
    expect(confirm).toHaveBeenCalledWith("Delete? ");
    expect(restoreInputFocus).toHaveBeenCalledOnce();
    uninstall(); expect(target.confirm).toBe(confirm);
  });
  it("also restores after alerts without intercepting keyboard events or DOM focus", () => {
    const restoreInputFocus = vi.fn().mockResolvedValue(undefined), alert = vi.fn();
    const target = { confirm: vi.fn(), alert, desktop: { restoreInputFocus } } as unknown as Window;
    installNativeDialogFocusRecovery(target);
    target.alert("Done");
    expect(alert).toHaveBeenCalledWith("Done");
    expect(restoreInputFocus).toHaveBeenCalledOnce();
  });
  it("leaves browser-only sessions unchanged", () => {
    const confirm = vi.fn(); const target = { confirm } as unknown as Window;
    installNativeDialogFocusRecovery(target)();
    expect(target.confirm).toBe(confirm);
  });
});
