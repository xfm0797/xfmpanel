/**
 * agent 操作注册表：只有在这里登记过的 op 才能被面板调用。
 */

import { systemOps } from './system.js';
import { serviceOps } from './service.js';
import { runtimeOps } from './runtime.js';
import { siteOps } from './site.js';
import { certOps } from './cert.js';

export const ops = {
  ...systemOps,
  ...serviceOps,
  ...runtimeOps,
  ...siteOps,
  ...certOps,
};

export function listOps() {
  return Object.keys(ops).sort();
}
