import { config } from './config.js';
import { logger } from './logger.js';
import { initDb, closeDb, getAllChannels } from './db.js';
import { startDiscord, stopDiscord, getBotTag } from './discord/client.js';
import { startArchiveCleanup } from './session/archive-cleanup.js';
import { startMediaCleanup } from './session/media.js';
import { refreshModelCatalog, stopModelCatalog } from './agent/model-catalog.js';
import { startProcessingLoop, stopProcessingLoop } from './agent/queue.js';
import { startScheduler } from './agent/scheduler.js';
import { acquireInstanceLock } from './instance-lock.js';
import { startThreadMaintenance } from './discord/threads.js';

/**
 * pi-discord-gateway - Lightweight Discord gateway for pi coding agent.
 *
 * Architecture inspired by NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Discord messages -> SQLite queue -> pi subprocess -> Discord response.
 */
export async function startGateway(): Promise<void> {
  if (!config.discordToken) {
    throw new Error(
      'DISCORD_BOT_TOKEN is required. Set it in config.env, .env, or the environment.',
    );
  }

  const releaseLock = await acquireInstanceLock(config.dbPath, (err) => {
    logger.fatal({ err }, 'Gateway instance lock lost');
    process.exitCode = 1;
    void stopProcessingLoop({ timeoutMs: 0 })
      .then(() => shutdown('instance lock lost'))
      .catch((error) => logger.error({ err: error }, 'Cleanup after lock loss failed'))
      .finally(() => resolveSignalWait());
  });
  try {
    initDb();
  } catch (error) {
    closeDb();
    await releaseLock();
    throw error;
  }

  let stopArchiveCleanup = () => {};
  let stopMediaCleanup = () => {};
  let stopScheduler = () => {};
  let stopThreads: () => Promise<void> = async () => {};
  let processingStarted = false;
  let shutdownPromise: Promise<void> | null = null;

  let resolveSignalWait!: () => void;
  const signalWait = new Promise<void>((resolve) => {
    resolveSignalWait = resolve;
  });

  const onSignal = (sig: NodeJS.Signals) => {
    void shutdown(`received ${sig}`).then(resolveSignalWait, resolveSignalWait);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (process.platform === 'win32') {
    process.once('SIGBREAK', onSignal);
  }

  const shutdown = (reason: string) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (process.platform === 'win32') {
        process.off('SIGBREAK', onSignal);
      }

      logger.info({ reason }, 'Shutting down gateway');

      stopScheduler();
      // Stop dispatch and start the grace timer before waiting on Discord I/O.
      const stoppedProcessing = processingStarted
        ? stopProcessingLoop({ timeoutMs: config.shutdownTimeoutMs })
        : Promise.resolve();
      stopArchiveCleanup();
      stopMediaCleanup();
      await Promise.all([stoppedProcessing, stopThreads()]);

      await stopModelCatalog();
      stopDiscord();
      closeDb();
      await releaseLock();
      logger.info('Gateway stopped');
    })();

    return shutdownPromise;
  };

  try {
    logger.info('Starting pi-discord-gateway...');
    void warmModelCatalogs();

    await startDiscord();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }

    startProcessingLoop();
    processingStarted = true;
    stopScheduler = startScheduler();
    stopThreads = startThreadMaintenance();
    stopArchiveCleanup = startArchiveCleanup();
    stopMediaCleanup = startMediaCleanup();

    logger.info(
      {
        bot: getBotTag(),
        trigger: `@${config.triggerName}`,
        concurrency: config.maxConcurrency,
        scheduledConcurrency: config.maxScheduledConcurrency,
        sessionsDir: config.sessionsDir,
      },
      'Gateway running',
    );

    await signalWait;
  } catch (err) {
    await shutdown('startup failure');
    throw err;
  }
}

async function warmModelCatalogs(): Promise<void> {
  const workingDirectories = new Set([
    config.piCwd,
    ...getAllChannels()
      .map((channel) => channel.cwdOverride)
      .filter(Boolean),
  ]);

  await Promise.allSettled(
    [...workingDirectories].map(async (cwd) => {
      try {
        const models = await refreshModelCatalog(cwd);
        logger.info({ cwd, models: models.length }, 'Model catalog warmed');
      } catch (err: any) {
        logger.warn({ cwd, err: err.message }, 'Failed to warm model catalog');
      }
    }),
  );
}
