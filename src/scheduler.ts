import { Cron } from 'croner';
import { config } from './config.js';
import {
  enqueueMessage,
  getDueScheduledTasks,
  type ScheduledTaskRow,
  type ScheduledTaskType,
  updateTaskAfterRun,
} from './db.js';
import { logger } from './logger.js';

const SCHEDULER_INTERVAL_MS = 30_000;

let schedulerTimer: NodeJS.Timeout | undefined;

export function computeNextRun(schedule: string, type: ScheduledTaskType): string | null {
  if (type === 'once') {
    const nextRun = new Date(schedule);
    if (Number.isNaN(nextRun.getTime()) || nextRun.getTime() <= Date.now()) {
      return null;
    }

    return schedule;
  }

  try {
    return new Cron(schedule).nextRun()?.toISOString() ?? null;
  } catch {
    return null;
  }
}

export function startScheduler(): () => void {
  if (schedulerTimer) {
    return stopScheduler;
  }

  const tick = () => {
    try {
      enqueueDueTasks();
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Scheduler tick failed');
    }
  };

  tick();
  schedulerTimer = setInterval(tick, SCHEDULER_INTERVAL_MS);

  logger.info({ intervalMs: SCHEDULER_INTERVAL_MS, maxPerTick: config.maxScheduledConcurrency }, 'Scheduler started');

  return stopScheduler;
}

function stopScheduler(): void {
  if (!schedulerTimer) {
    return;
  }

  clearInterval(schedulerTimer);
  schedulerTimer = undefined;
  logger.info('Scheduler stopped');
}

function enqueueDueTasks(): void {
  const now = new Date().toISOString();
  const dueTasks = getDueScheduledTasks().slice(0, config.maxScheduledConcurrency);

  for (const task of dueTasks) {
    enqueueDueTask(task, now);
  }
}

function enqueueDueTask(task: ScheduledTaskRow, now: string): void {
  enqueueMessage({
    channelJid: task.channel_jid,
    sender: 'scheduler',
    senderName: 'Scheduler',
    content: task.prompt,
    timestamp: now,
  });

  updateTaskAfterRun(task.id, now, computeNextRun(task.schedule, task.type));
}
