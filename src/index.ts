import { config } from './config.js';
import { logger } from './logger.js';
import { initDb, closeDb } from './db.js';
import { startDiscord, stopDiscord, getBotTag } from './discord.js';
import { startArchiveCleanup } from './archive-cleanup.js';
import { startMediaCleanup } from './media.js';
import { startProcessingLoop, stopProcessingLoop } from './queue.js';

/**
 * pi-discord-gateway - Lightweight Discord gateway for pi coding agent.
 *
 * Architecture inspired by NanoClaw (https://github.com/qwibitai/nanoclaw).
 * Discord messages -> SQLite queue -> pi subprocess -> Discord response.
 */
export async function startGateway(): Promise<void> {
  if (!config.discordToken) {
    throw new Error('DISCORD_BOT_TOKEN is required. Set it in config.env, .env, or the environment.');
  }

  initDb();

  let stopArchiveCleanup = () => {};
  let stopMediaCleanup = () => {};
  let processingStarted = false;
  let shutdownPromise: Promise<void> | null = null;

  let resolveSignalWait!: () => void;
  const signalWait = new Promise<void>((resolve) => { resolveSignalWait = resolve; });

  const onSignal = (sig: NodeJS.Signals) => {
    void shutdown(`received ${sig}`).then(resolveSignalWait, resolveSignalWait);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  const shutdown = (reason: string) => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);

      logger.info({ reason }, 'Shutting down gateway');

      stopArchiveCleanup();
      stopMediaCleanup();

      if (processingStarted) {
        await stopProcessingLoop({ timeoutMs: config.shutdownTimeoutMs });
      }

      stopDiscord();
      closeDb();
      logger.info('Gateway stopped');
    })();

    return shutdownPromise;
  };

  try {
    logger.info('Starting pi-discord-gateway...');

    await startDiscord();
    if (shutdownPromise) {
      await shutdownPromise;
      return;
    }

    startProcessingLoop();
    processingStarted = true;
    stopArchiveCleanup = startArchiveCleanup();
    stopMediaCleanup = startMediaCleanup();

    logger.info({
      bot: getBotTag(),
      trigger: `@${config.triggerName}`,
      concurrency: config.maxConcurrency,
      sessionsDir: config.sessionsDir,
    }, 'Gateway running');

    await signalWait;
  } catch (err) {
    await shutdown('startup failure');
    throw err;
  }
}
