/**
 * 系统设置接口（证书邮箱、默认 PHP 版本、通知 Webhook 等）。
 * 只有 owner 能写，避免运维误改影响全局。
 */

import { perm } from '../http/security.js';
import { getSettings, setSetting } from '../db/seed.js';
import { errors } from '../lib/errors.js';
import { AUDIT_ACTIONS } from '../../../shared/protocol.js';
import { assertEnum, assertInt } from '../../../shared/validate.js';

const SCHEMA = {
  'panel.name': { type: 'string', max: 40 },
  'panel.publicUrl': { type: 'url', optional: true },
  'site.defaultAppType': { type: 'enum', values: ['php', 'static', 'proxy'] },
  'site.defaultPhpVersion': { type: 'string', pattern: /^\d\.\d$/ },
  'site.defaultRewrite': { type: 'enum', values: ['none', 'wordpress', 'laravel', 'thinkphp', 'discuz'] },
  'cert.email': { type: 'email', optional: true },
  'cert.autoRenew': { type: 'bool' },
  'cert.renewBeforeDays': { type: 'int', min: 7, max: 60 },
  'security.sessionTtlHours': { type: 'int', min: 1, max: 168 },
  'ops.taskRetentionDays': { type: 'int', min: 1, max: 365 },
  'ops.backupBeforeDelete': { type: 'bool' },
  'notify.webhookUrl': { type: 'url', optional: true },
};

export function registerSettingsRoutes(app) {
  app.get('/api/v1/settings', perm('settings:read'), async () => ({
    settings: getSettings(),
    schema: SCHEMA,
  }));

  app.patch('/api/v1/settings', perm('settings:write'), async (ctx) => {
    const patch = ctx.body || {};
    const changed = [];
    for (const [key, raw] of Object.entries(patch)) {
      const rule = SCHEMA[key];
      if (!rule) throw errors.validation(`未知设置项：${key}`, key);
      const value = validate(key, rule, raw);
      setSetting(key, value, ctx.user.id);
      changed.push(key);
    }
    ctx.audit(AUDIT_ACTIONS.SETTINGS_UPDATE, {
      resource: 'settings',
      detail: { keys: changed, values: Object.fromEntries(changed.map((k) => [k, patch[k]])) },
    });
    return { settings: getSettings(), changed };
  });
}

function validate(key, rule, raw) {
  const value = raw === null || raw === undefined ? '' : String(raw);
  if (rule.optional && value === '') return '';
  switch (rule.type) {
    case 'string':
      if (!value.trim()) throw errors.validation(`${key} 不能为空`, key);
      if (value.length > rule.max) throw errors.validation(`${key} 过长`, key);
      if (rule.pattern && !rule.pattern.test(value)) throw errors.validation(`${key} 格式不正确`, key);
      return value.trim();
    case 'url':
      if (!/^https?:\/\/[^\s]+$/.test(value)) throw errors.validation(`${key} 必须是 http(s) 地址`, key);
      return value;
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(value)) {
        throw errors.validation('邮箱格式不正确', key);
      }
      return value;
    case 'bool':
      return ['1', 'true', 'on', 'yes'].includes(value.toLowerCase()) ? 'true' : 'false';
    case 'int':
      return String(assertInt(value, { field: key, min: rule.min, max: rule.max }));
    case 'enum':
      return assertEnum(value, rule.values, key);
    default:
      throw errors.validation(`未知校验类型 ${rule.type}`, key);
  }
}
