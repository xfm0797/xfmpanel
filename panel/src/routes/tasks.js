/**
 * 任务接口 + SSE 实时事件流。
 *
 * 前端打开任务详情时先拉一次 /events 里已落库的历史事件，再挂 SSE 追增量，
 * 断线重连带上 after=<最后 seq> 即可无缝续传。
 */

import { perm } from '../http/security.js';
import {
  listTasks, getTask, getTaskEvents, onTaskEvent, cancelTask, taskStats,
} from '../services/tasks.js';
import { AUDIT_ACTIONS } from '../../../shared/protocol.js';
import { errors } from '../lib/errors.js';

export function registerTaskRoutes(app) {
  app.get('/api/v1/tasks', perm('task:read'), async (ctx) => listTasks(ctx.query));

  app.get('/api/v1/tasks/stats', perm('task:read'), async () => taskStats());

  app.get('/api/v1/tasks/:id', perm('task:read'), async (ctx) => {
    const task = getTask(ctx.params.id);
    if (!task) throw errors.notFound('任务不存在');
    return {
      ...task,
      events: getTaskEvents(task.id, { limit: 200 }),
    };
  });

  app.get('/api/v1/tasks/:id/events', perm('task:read'), async (ctx) => {
    const task = getTask(ctx.params.id);
    if (!task) throw errors.notFound('任务不存在');

    const after = Number(ctx.query.after) || 0;
    const sse = ctx.sse();

    sse.send('meta', { taskId: task.id, status: task.status, type: task.type, title: task.title });
    for (const ev of getTaskEvents(task.id, { afterSeq: after })) sse.send('log', ev);

    if (!['queued', 'running'].includes(task.status)) {
      sse.send('done', { status: task.status, error: task.error, progress: task.progress });
      sse.close();
      return undefined;
    }

    const off = onTaskEvent(task.id, (ev) => {
      if (ev.seq === -1) {
        const latest = getTask(task.id);
        sse.send('done', {
          status: latest?.status || 'unknown',
          error: latest?.error,
          progress: latest?.progress ?? 100,
        });
        sse.close();
        return;
      }
      sse.send('log', ev);
    });

    // 保活 + 兜底：任务结束时若事件丢失，最多 2 分钟内自动收尾
    const guard = setInterval(() => {
      const latest = getTask(task.id);
      if (!latest || !['queued', 'running'].includes(latest.status)) {
        sse.send('done', { status: latest?.status || 'unknown', error: latest?.error });
        sse.close();
      }
    }, 15000);
    guard.unref?.();

    const cleanup = () => {
      clearInterval(guard);
      off();
    };
    ctx.req.on('close', cleanup);
    ctx.res.on('close', cleanup);

    return undefined;
  });

  app.post('/api/v1/tasks/:id/cancel', perm('task:cancel'), async (ctx) => {
    const task = cancelTask(ctx.params.id, ctx.user);
    ctx.audit(AUDIT_ACTIONS.TASK_CANCEL, { resource: 'task', resourceId: task.id });
    return task;
  });
}
