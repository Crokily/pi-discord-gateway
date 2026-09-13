/** A short-lived SDK probe with graceful cancellation of pi storage operations. */
export {};
const controller = new AbortController();
const stop = () => controller.abort();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

async function probe(): Promise<void> {
  const [{ ModelRuntime, SettingsManager }, PiAI] = await Promise.all([
    import('@earendil-works/pi-coding-agent'),
    import('@earendil-works/pi-ai'),
  ]);
  controller.signal.throwIfAborted();
  const settings = SettingsManager.create(process.cwd());
  console.log(JSON.stringify({ type: 'settings', patterns: settings.getEnabledModels() ?? [] }));
  const runtime = await ModelRuntime.create({
    allowModelNetwork: false,
    signal: controller.signal,
  });
  controller.signal.throwIfAborted();
  const thinking = PiAI as unknown as {
    getSupportedThinkingLevels?: (model: unknown) => readonly string[];
    supportsXhigh?: (model: unknown) => boolean;
  };
  const models = runtime.getAvailableSnapshot().map((model) => ({
    ref: `${model.provider}/${model.id}`,
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    supportsXhigh:
      thinking.getSupportedThinkingLevels?.(model).includes('xhigh') ??
      thinking.supportsXhigh?.(model) ??
      false,
  }));
  console.log(JSON.stringify({ type: 'models', models }));
}

void probe()
  .catch((error: unknown) => {
    // Do not throw out of the module: Node must drain pending SDK lock-release callbacks.
    if (!controller.signal.aborted)
      console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  });
