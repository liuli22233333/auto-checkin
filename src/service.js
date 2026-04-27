import { checkCheckinCompleted, runCheckinWithRetries } from './automation/checkin-runner.js';
import { todayKey } from './domain/time-window.js';

function makeRunId(dateKey) {
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${dateKey}-${nonce}`;
}

export async function startService({ config, logger }) {
  const dateKey = todayKey(new Date());
  const runId = makeRunId(dateKey);

  await logger.info('service_start', {
    mode: 'one_shot',
    timezone: config.timezone,
  });

  if (config.precheckEnabled) {
    try {
      const precheck = await checkCheckinCompleted({
        config,
        runId,
        logger,
      });

      if (precheck.completed) {
        await logger.info('precheck_completed', {
          run_id: runId,
          ...precheck.summary,
        });

        await logger.info('workflow_finished', {
          run_id: runId,
          reason: 'precheck_completed',
        });

        return {
          async stop() {
            await logger.info('service_stop', {});
          },
        };
      }
    } catch (error) {
      await logger.warn('precheck_failed_continue', {
        run_id: runId,
        error,
      });
    }
  } else {
    await logger.info('precheck_skipped', {
      run_id: runId,
      reason: 'CHECKIN_PRECHECK=false',
    });
  }

  try {
    const result = await runCheckinWithRetries({
      config,
      runId,
      logger,
    });

    if (result.status === 'success') {
      await logger.info('checkin_success', {
        run_id: runId,
        ...result.summary,
      });

      await logger.info('workflow_finished', {
        run_id: runId,
        reason: 'run_success',
      });
    } else {
      await logger.error('checkin_failed', {
        run_id: runId,
        attempts: result.attempts,
        error_message: result.error?.message || 'unknown',
        screenshot: result.error?.screenshotPath || 'none',
      });

      await logger.info('workflow_finished', {
        run_id: runId,
        reason: 'run_failed',
      });
    }
  } catch (error) {
    await logger.error('run_crashed', {
      run_id: runId,
      error,
    });
  }

  return {
    async stop() {
      await logger.info('service_stop', {});
    },
  };
}
