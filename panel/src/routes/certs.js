/**
 * SSL 证书接口。
 */

import { perm } from '../http/security.js';
import {
  listCertificates, issueCertificate, renewCertificate, revokeCertificate, uploadCertificate,
  certStats, getCertificate, refreshCertificateStatuses, scheduleRenewals,
} from '../services/certs.js';
import { AUDIT_ACTIONS } from '../../../shared/protocol.js';
import { assertInt } from '../../../shared/validate.js';

export function registerCertRoutes(app) {
  app.get('/api/v1/certificates', perm('cert:read'), async (ctx) => listCertificates(ctx.query));

  app.get('/api/v1/certificates/stats', perm('cert:read'), async () => certStats());

  app.post('/api/v1/certificates/issue', perm('cert:write'), async (ctx) => {
    const siteId = assertInt(ctx.body?.siteId, { field: 'siteId', min: 1 });
    const result = issueCertificate(
      { siteId, domains: ctx.body?.domains, force: Boolean(ctx.body?.force) },
      ctx.user,
    );
    ctx.audit(AUDIT_ACTIONS.CERT_ISSUE, {
      resource: 'cert',
      resourceId: result.certId,
      detail: { siteId, domains: ctx.body?.domains, force: Boolean(ctx.body?.force), taskId: result.task.id },
    });
    return ctx.json({ ok: true, data: result }, 202);
  });

  app.post('/api/v1/certificates/:id/renew', perm('cert:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const cert = getCertificate(id);
    const result = renewCertificate(id, ctx.user);
    ctx.audit(AUDIT_ACTIONS.CERT_RENEW, {
      resource: 'cert',
      resourceId: id,
      detail: { domain: cert.domain, taskId: result.task.id },
    });
    return result;
  });

  app.post('/api/v1/certificates/:id/revoke', perm('cert:write'), async (ctx) => {
    const id = assertInt(ctx.params.id, { field: 'id', min: 1 });
    const cert = getCertificate(id);
    const result = revokeCertificate(id, ctx.user);
    ctx.audit(AUDIT_ACTIONS.CERT_REVOKE, {
      resource: 'cert',
      resourceId: id,
      detail: { domain: cert.domain, taskId: result.task.id },
    });
    return result;
  });

  app.post('/api/v1/certificates/upload', perm('cert:write'), async (ctx) => {
    const siteId = assertInt(ctx.body?.siteId, { field: 'siteId', min: 1 });
    const result = uploadCertificate({
      siteId,
      domain: ctx.body?.domain,
      certPem: String(ctx.body?.certPem || ''),
      keyPem: String(ctx.body?.keyPem || ''),
      chainPem: String(ctx.body?.chainPem || ''),
    }, ctx.user);
    ctx.audit(AUDIT_ACTIONS.CERT_UPLOAD, {
      resource: 'cert',
      resourceId: result.certId,
      detail: { siteId, domain: ctx.body?.domain, taskId: result.task.id },
    });
    return ctx.json({ ok: true, data: result }, 202);
  });

  /** 手动触发证书巡检（管理员排障用） */
  app.post('/api/v1/certificates/scan', perm('cert:write'), async (ctx) => {
    const refreshed = refreshCertificateStatuses();
    const scheduled = scheduleRenewals();
    ctx.audit(AUDIT_ACTIONS.CERT_RENEW, { resource: 'cert', detail: { manualScan: true, ...refreshed } });
    return { ...refreshed, ...scheduled };
  });
}
