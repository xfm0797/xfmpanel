#!/usr/bin/env node
/**
 * 端到端冒烟测试：验证「登录 → 装环境 → 建站 → 签证书 → 停用/启用 → 删除」全链路。
 *
 * 用法（开发模式，走 stub agent）：
 *   node panel/src/server.js &        # 或 npm start
 *   npm test
 *
 * 生产环境请勿对线上面板执行，脚本会创建并删除名为 smoke-test-* 的站点。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.XFMP_BASE || 'http://127.0.0.1:8787';
const USERNAME = process.env.XFMP_USER || 'admin';

let cookie = '';
let csrf = '';
let passed = 0;
let failed = 0;

function readInitialPassword() {
  if (process.env.XFMP_PASSWORD) return process.env.XFMP_PASSWORD;
  const file = path.join(__dirname, '..', 'data', 'initial-admin.txt');
  if (!fs.existsSync(file)) return null;
  const m = /密码:\s*(\S+)/.exec(fs.readFileSync(file, 'utf8'));
  return m ? m[1] : null;
}

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(pathname, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  for (const c of setCookie) {
    const m = /^(xfm_sid=[^;]*)/.exec(c);
    if (m) cookie = m[1];
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (raw) return { status: res.status, json, text };
  return { status: res.status, json, text };
}

async function waitTask(taskId, { timeoutMs = 120000, verbose = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let printed = 0;
  while (Date.now() < deadline) {
    const { json } = await api(`/api/v1/tasks/${taskId}`);
    const task = json?.data;
    if (!task) throw new Error(`任务 ${taskId} 不存在`);
    if (verbose && task.events) {
      for (const ev of task.events.slice(printed)) {
        console.log(`      [${ev.level}] ${ev.message}`);
      }
      printed = task.events.length;
    }
    if (!['queued', 'running'].includes(task.status)) return task;
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`任务 ${taskId} 超时`);
}

async function main() {
  console.log(`\nXFMPanel 冒烟测试 → ${BASE}\n`);

  console.log('[1] 健康检查与鉴权');
  const health = await api('/api/v1/system/health');
  ok('健康检查返回 ok', health.status === 200 && health.json?.data?.panel === 'ok');
  ok('agent 在线', health.json?.data?.agent?.ok === true, health.json?.data?.agent?.error);

  const anon = await api('/api/v1/sites');
  ok('未登录访问站点列表返回 401', anon.status === 401, `实际 ${anon.status}`);

  const badLogin = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { username: '__nobody__', password: 'wrong-pass-123' },
  });
  ok('错误账号登录被拒绝', badLogin.status === 401);

  const password = readInitialPassword();
  if (!password) {
    console.error('未找到初始密码（data/initial-admin.txt 或 XFMP_PASSWORD）');
    process.exit(1);
  }
  const login = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { username: USERNAME, password },
  });
  ok('管理员登录成功', login.status === 200 && login.json?.data?.csrfToken);
  csrf = login.json?.data?.csrfToken || '';
  ok('下发会话 Cookie', cookie.startsWith('xfm_sid='));

  const wrongCsrf = await fetch(`${BASE}/api/v1/sites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: 'x' }),
  });
  ok('缺少 CSRF 头的写请求被拒绝', wrongCsrf.status === 403, `实际 ${wrongCsrf.status}`);

  console.log('\n[2] 网站环境安装');
  const installNginx = await api('/api/v1/runtimes/install', {
    method: 'POST', body: { kind: 'nginx', version: '1.26' },
  });
  if (installNginx.status === 202) {
    ok('发起 Nginx 安装任务', true);
    const nginxTask = await waitTask(installNginx.json.data.task.id, { verbose: true });
    ok('Nginx 安装任务成功', nginxTask.status === 'success', nginxTask.error);
  } else {
    ok('Nginx 已安装（重复安装被拒绝）', installNginx.status === 409, JSON.stringify(installNginx.json));
  }

  const installPhp = await api('/api/v1/runtimes/install', {
    method: 'POST', body: { kind: 'php', version: '8.3' },
  });
  if (installPhp.status === 202) {
    const phpTask = await waitTask(installPhp.json.data.task.id);
    ok('PHP 8.3 安装任务成功', phpTask.status === 'success', phpTask.error);
  } else {
    ok('PHP 8.3 已安装（重复安装被拒绝）', installPhp.status === 409);
  }

  const runtimes = await api('/api/v1/runtimes');
  const installed = runtimes.json?.data?.installed || [];
  ok('运行环境列表包含 nginx 与 php', installed.some((r) => r.kind === 'nginx') && installed.some((r) => r.kind === 'php'));

  console.log('\n[3] 站点创建（含自动申请证书）');
  const slug = `smoke-${Date.now().toString(36).slice(-5)}`;
  const createSite = await api('/api/v1/sites', {
    method: 'POST',
    body: {
      name: '冒烟测试站点',
      slug,
      domains: [`${slug}.example.com`],
      appType: 'php',
      phpVersion: '8.3',
      sslMode: 'acme',
      settings: { rewrite: 'wordpress', clientMaxBodySizeMb: 128 },
    },
  });
  ok('创建站点返回 201', createSite.status === 201, JSON.stringify(createSite.json));
  const siteId = createSite.json.data.site.id;
  const createTask = await waitTask(createSite.json.data.task.id, { verbose: true });
  ok('建站任务成功', createTask.status === 'success', createTask.error);

  const siteDetail = await api(`/api/v1/sites/${siteId}`);
  ok('站点状态为 active', siteDetail.json?.data?.status === 'active', siteDetail.json?.data?.lastError);
  ok('站点已签发证书', (siteDetail.json?.data?.certificates || []).some((c) => c.status === 'issued'));

  const cfg = await api(`/api/v1/sites/${siteId}/config`);
  const vhost = cfg.json?.data?.vhost || '';
  ok('配置预览包含 server_name', vhost.includes(`server_name ${slug}.example.com`));
  ok('配置预览包含 443 监听', vhost.includes('listen 443 ssl'));
  ok('443 监听兼容 nginx 1.22', vhost.includes('listen 443 ssl http2') && !vhost.includes('http2 on'));
  ok('PHP pool 锁定 open_basedir', (cfg.json?.data?.pool || '').includes('open_basedir'));

  console.log('\n[4] 站点停用 / 启用 / 重载');
  const disable = await api(`/api/v1/sites/${siteId}/state`, { method: 'POST', body: { status: 'stopped' } });
  await waitTask(disable.json.data.task.id);
  const afterDisable = await api(`/api/v1/sites/${siteId}`);
  ok('停用后状态为 stopped', afterDisable.json?.data?.status === 'stopped');

  const enable = await api(`/api/v1/sites/${siteId}/state`, { method: 'POST', body: { status: 'active' } });
  await waitTask(enable.json.data.task.id);
  const afterEnable = await api(`/api/v1/sites/${siteId}`);
  ok('启用后状态为 active', afterEnable.json?.data?.status === 'active');

  const reload = await api(`/api/v1/sites/${siteId}/reload`, { method: 'POST' });
  const reloadTask = await waitTask(reload.json.data.task.id);
  ok('重载服务任务成功', reloadTask.status === 'success', reloadTask.error);

  console.log('\n[5] 证书续期与异常提示');
  const certs = await api('/api/v1/certificates');
  const cert = certs.json?.data?.find?.((c) => c.siteId === siteId) || certs.json?.data?.[0];
  ok('证书列表可读', Array.isArray(certs.json?.data));

  if (cert?.id) {
    const renew = await api(`/api/v1/certificates/${cert.id}/renew`, { method: 'POST' });
    const renewTask = await waitTask(renew.json.data.task.id);
    ok('证书续期任务成功', renewTask.status === 'success', renewTask.error);
  }

  const badSite = await api('/api/v1/sites', {
    method: 'POST',
    body: { name: 'failing', slug: `fail-${Date.now().toString(36).slice(-4)}`, domains: ['fail-test.example.com'], phpVersion: '8.3' },
  });
  if (badSite.status === 201) {
    const t = await waitTask(badSite.json.data.task.id);
    ok('坏配置任务按预期失败并记录错误', t.status === 'failed' && Boolean(t.error));
    const bad = await api(`/api/v1/sites/${badSite.json.data.site.id}`);
    ok('失败站点状态为 error 且带 lastError', bad.json?.data?.status === 'error' && Boolean(bad.json?.data?.lastError));
    await api(`/api/v1/sites/${badSite.json.data.site.id}?keepFiles=1&backup=0`, { method: 'DELETE' });
  }

  console.log('\n[6] 日志、审计与概览');
  const logs = await api('/api/v1/logs/panel?lines=50');
  ok('面板日志可读', logs.status === 200 && Array.isArray(logs.json?.data?.lines));

  const siteLogs = await api(`/api/v1/sites/${siteId}/logs?type=access&lines=10`);
  ok('站点访问日志可读', siteLogs.status === 200 && Array.isArray(siteLogs.json?.data?.lines));

  const audit = await api('/api/v1/logs/audit');
  const actions = (audit.json?.data?.items || []).map((i) => i.action);
  ok('审计日志记录了登录', actions.includes('auth.login'));
  ok('审计日志记录了建站', actions.includes('site.create'));

  const overview = await api('/api/v1/system/overview');
  ok('概览接口返回站点统计', typeof overview.json?.data?.sites?.total === 'number');
  ok('概览接口返回证书统计', typeof overview.json?.data?.certs?.total === 'number');

  const metrics = await api('/api/v1/system/metrics');
  const m = metrics.json?.data;
  ok('指标接口可用', metrics.status === 200 && m?.available === true, JSON.stringify(m?.error));
  ok('指标包含 CPU / 内存 / 磁盘 / 网络',
    typeof m?.current?.cpu?.usage === 'number' &&
    typeof m?.current?.mem?.usagePercent === 'number' &&
    typeof m?.current?.disk?.usagePercent === 'number' &&
    typeof m?.current?.net?.rxBps === 'number');
  ok('指标返回时间序列', Array.isArray(m?.series));

  console.log('\n[7] 设置项与静态缓存');
  const home = await fetch(`${BASE}/`);
  const etag = home.headers.get('etag');
  ok('首页返回 ETag', Boolean(etag));
  const cached = await fetch(`${BASE}/`, { headers: { 'If-None-Match': etag } });
  ok('静态资源命中 ETag 返回 304', cached.status === 304, `实际 ${cached.status}`);

  const disableAuto = await api('/api/v1/settings', {
    method: 'PATCH', body: { 'cert.autoRenew': 'false' },
  });
  ok('设置可关闭自动续期', disableAuto.status === 200);
  const scan = await api('/api/v1/certificates/scan', { method: 'POST' });
  ok('关闭自动续期后巡检不入队', scan.json?.data?.disabled === true, JSON.stringify(scan.json?.data));
  await api('/api/v1/settings', { method: 'PATCH', body: { 'cert.autoRenew': 'true' } });

  const badSetting = await api('/api/v1/settings', {
    method: 'PATCH', body: { 'security.loginMaxAttempts': '0' },
  });
  ok('非法登录锁定阈值被拒绝', badSetting.status === 422, `实际 ${badSetting.status}`);

  console.log('\n[8] 删除站点（先备份）');
  const del = await api(`/api/v1/sites/${siteId}?keepFiles=1&backup=1`, { method: 'DELETE' });
  ok('删除请求被接受', del.status === 200, JSON.stringify(del.json));
  const delTask = await waitTask(del.json.data.task.id, { verbose: true });
  ok('删除任务成功', delTask.status === 'success', delTask.error);
  const gone = await api(`/api/v1/sites/${siteId}`);
  ok('站点已从数据库移除', gone.status === 404);

  const logout = await api('/api/v1/auth/logout', { method: 'POST' });
  ok('登出成功', logout.status === 200);

  console.log(`\n结果：${passed} 通过 / ${failed} 失败\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常中断：', err.message);
  process.exit(1);
});
