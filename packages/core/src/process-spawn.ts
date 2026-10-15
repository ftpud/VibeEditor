/** Retry only failures before a child starts. Never replay a failed command. */
export async function retryProcessSpawn<T>(operation: () => Promise<T>, pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      const detail = error as NodeJS.ErrnoException;
      if (!detail.syscall?.startsWith("spawn") || !["EIO", "EMFILE", "ENFILE", "EAGAIN"].includes(detail.code ?? "") || attempt >= 2) throw error;
      await pause(100 * (attempt + 1));
    }
  }
}
