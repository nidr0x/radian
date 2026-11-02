// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- Wrangler generates the global Env declaration.
/// <reference path="./worker-configuration.d.ts" />

import { dispatchDueJobs, processQueueBatch, type QueueBatchLike } from '../functions/lib/radian-api/jobs-worker';
import { drainMediaCleanup, type MediaCleanupBucket } from '../functions/lib/radian-api/media-cleanup';
import type { PushEnvironment } from '../functions/lib/radian-api/push';

interface ScheduledControllerLike { cron: string }
interface ExecutionContextLike { waitUntil(promise: Promise<unknown>): void }
type WorkerBindings = Env & PushEnvironment & { MEDIA_BUCKET?: MediaCleanupBucket };

export default {
  queue(batch: QueueBatchLike, env: WorkerBindings): Promise<void> {
    return processQueueBatch(batch, env);
  },
  scheduled(_controller: ScheduledControllerLike, env: WorkerBindings, context: ExecutionContextLike): void {
    if (env.PUSH_QUEUE) context.waitUntil(dispatchDueJobs(env.DB, env.PUSH_QUEUE));
    if (env.MEDIA_BUCKET) context.waitUntil(drainMediaCleanup(env.DB, env.MEDIA_BUCKET));
  },
};
