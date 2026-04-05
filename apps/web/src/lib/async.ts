export function reportBackgroundError(message: string, error: unknown): void {
  console.warn(message, error);
}

export function runAsyncTask(task: PromiseLike<unknown>, message: string): void {
  void Promise.resolve(task).catch((error: unknown) => {
    reportBackgroundError(message, error);
  });
}
