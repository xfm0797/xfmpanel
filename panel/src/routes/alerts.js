/**
 * 告警接口。
 */

import { perm } from '../http/security.js';
import { listAlerts, ackAlert, openAlertCount } from '../services/alerts.js';
import { assertInt } from '../../../shared/validate.js';
import { AUDIT_ACTIONS } from '../../../shared/protocol.js';

export function registerAlertRoutes(app) {
  app.get('/api/v1/alerts', perm('alert:read'), async (ctx) => ({
    ...listAlerts(ctx.query),
    openCount: openAlertCount(),
  }));

  app.get('/api/v1/alerts/count', perm('alert:read'), async () => ({ open: openAlertCount() }));

  app.post('/api/v1/alerts/:id/ack', perm('alert:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const ok = ackAlert(id, ctx.user.id);
    ctx.audit(AUDIT_ACTIONS.SETTINGS_UPDATE, { resource: 'alert', resourceId: id, detail: { ack: ok } });
    return { acknowledged: ok };
  });
}
