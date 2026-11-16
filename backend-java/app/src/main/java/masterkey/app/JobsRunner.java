// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import com.github.kagkarlsson.scheduler.Scheduler;
import org.jspecify.annotations.Nullable;
import org.springframework.context.SmartLifecycle;

/**
 * Starts db-scheduler's worker after everything else is ready and stops it first, waiting for
 * the jobs under way: their transactions end before the pool closes. Null: not a worker.
 */
final class JobsRunner implements SmartLifecycle {

    private final @Nullable Scheduler scheduler;
    private volatile boolean running;

    JobsRunner(@Nullable Scheduler scheduler) {
        this.scheduler = scheduler;
    }

    @Override
    public void start() {
        if (scheduler != null) scheduler.start();
        running = true;
    }

    @Override
    public void stop() {
        if (scheduler != null) scheduler.stop();
        running = false;
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    /** Late to start, early to stop: after the web server is up, before it goes down. */
    @Override
    public int getPhase() {
        return Integer.MAX_VALUE - 1000;
    }
}
