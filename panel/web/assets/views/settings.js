/**
 * 系统设置：面板标识、证书策略、默认站点参数、通知与路径信息。
 */

import { api, state } from '../api.js';
import * as ui from '../ui.js';

export async function render(el, ctx) {
  const [data, paths] = await Promise.all([
    api('/settings'),
    api('/system/paths').catch(() => ({ paths: {}, config: {} })),
  ]);
  const s = data.settings || {};
  const canWrite = state.me?.permissions?.includes('*') || state.me?.permissions?.includes('settings:write');
  const disabled = canWrite ? '' : 'disabled';

  el.innerHTML = `
    <form class="grid cols-2" data-role="form">
      <div class="card">
        <div class="card-head"><h2>面板</h2></div>
        <div class="field"><label>面板名称</label>
          <input class="input" data-k="panel.name" value="${ui.esc(s['panel.name'] || '')}" ${disabled} /></div>
        <div class="field"><label>对外访问地址</label>
          <input class="input" data-k="panel.publicUrl" placeholder="https://panel.example.com" value="${ui.esc(s['panel.publicUrl'] || '')}" ${disabled} />
          <div class="help">用于生成通知链接；留空则使用当前访问地址</div></div>
        <div class="field"><label>任务日志保留天数</label>
          <input class="input" type="number" min="1" max="365" data-k="ops.taskRetentionDays" value="${ui.esc(s['ops.taskRetentionDays'] || '30')}" ${disabled} /></div>
        <div class="check"><input type="checkbox" id="bk" data-k="ops.backupBeforeDelete" data-type="bool"
          ${s['ops.backupBeforeDelete'] === 'true' ? 'checked' : ''} ${disabled} />
          <label for="bk">删除站点前自动备份（推荐）</label></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>SSL 证书</h2></div>
        <div class="field"><label>ACME 联系邮箱</label>
          <input class="input" data-k="cert.email" type="email" placeholder="ops@example.com" value="${ui.esc(s['cert.email'] || '')}" ${disabled} />
          <div class="help">Let's Encrypt 到期提醒与账户恢复邮箱，强烈建议填写</div></div>
        <div class="field"><label>提前续期天数</label>
          <select class="select" data-k="cert.renewBeforeDays" ${disabled}>
            ${['15', '20', '30', '45'].map((d) => `<option value="${d}" ${s['cert.renewBeforeDays'] === d ? 'selected' : ''}>${d} 天</option>`).join('')}
          </select></div>
        <div class="check"><input type="checkbox" id="ar" data-k="cert.autoRenew" data-type="bool"
          ${s['cert.autoRenew'] !== 'false' ? 'checked' : ''} ${disabled} />
          <label for="ar">到期前自动续期</label></div>
        <div class="small faint mt">巡检每 6 小时执行一次；也可在证书页手动触发。</div>
      </div>

      <div class="card">
        <div class="card-head"><h2>站点默认参数</h2></div>
        <div class="row">
          <div class="field"><label>默认应用类型</label>
            <select class="select" data-k="site.defaultAppType" ${disabled}>
              ${[['php', 'PHP'], ['static', '静态'], ['proxy', '反向代理']].map(([v, l]) =>
                `<option value="${v}" ${s['site.defaultAppType'] === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div class="field"><label>默认 PHP 版本</label>
            <input class="input" data-k="site.defaultPhpVersion" value="${ui.esc(s['site.defaultPhpVersion'] || '8.3')}" ${disabled} /></div>
        </div>
        <div class="field"><label>默认伪静态</label>
          <select class="select" data-k="site.defaultRewrite" ${disabled}>
            ${['none', 'wordpress', 'laravel', 'thinkphp', 'discuz'].map((v) =>
              `<option value="${v}" ${s['site.defaultRewrite'] === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select></div>
        <div class="field"><label>安全提示</label>
          <div class="small dim">站点默认创建独立系统用户、禁用 exec/shell_exec 等函数、open_basedir 锁定在站点目录。</div></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>通知与路径</h2></div>
        <div class="field"><label>Webhook 地址（可选）</label>
          <input class="input" data-k="notify.webhookUrl" placeholder="https://hooks.example.com/xxx" value="${ui.esc(s['notify.webhookUrl'] || '')}" ${disabled} />
          <div class="help">新增告警会向该地址 POST JSON，可接入企业微信/飞书机器人</div></div>
        <dl class="kv">
          <dt>数据库</dt><dd>${ui.esc(paths.config?.dbPath || '')}</dd>
          <dt>日志目录</dt><dd>${ui.esc(paths.config?.logDir || '')}</dd>
          <dt>agent 模式</dt><dd>${ui.esc(paths.config?.agentMode || '')}</dd>
          <dt>agent socket</dt><dd>${ui.esc(paths.config?.agentSocket || '')}</dd>
          <dt>站点根目录</dt><dd>${ui.esc(paths.paths?.WWW_ROOT || '/www/xfm')}</dd>
        </dl>
        ${canWrite ? `<button class="btn btn-primary mt" type="submit">保存设置</button>` : '<div class="small faint mt">当前角色为只读，无法修改设置</div>'}
      </div>
    </form>
  `;

  el.querySelector('[data-role="form"]').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!canWrite) return;
    const payload = {};
    el.querySelectorAll('[data-k]').forEach((input) => {
      const key = input.dataset.k;
      if (input.dataset.type === 'bool') payload[key] = input.checked ? 'true' : 'false';
      else payload[key] = input.value.trim();
    });
    try {
      await api('/settings', { method: 'PATCH', body: payload });
      ui.toast('设置已保存');
      ctx.refresh();
    } catch (err) {
      ui.toast(err.message, 'err');
    }
  });
}
