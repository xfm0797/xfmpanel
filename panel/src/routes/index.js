/**
 * 路由注册入口。
 */

import { registerAuthRoutes } from './auth.js';
import { registerSiteRoutes } from './sites.js';
import { registerRuntimeRoutes } from './runtimes.js';
import { registerCertRoutes } from './certs.js';
import { registerTaskRoutes } from './tasks.js';
import { registerLogRoutes } from './logs.js';
import { registerSystemRoutes } from './system.js';
import { registerUserRoutes } from './users.js';
import { registerSettingsRoutes } from './settings.js';
import { registerAlertRoutes } from './alerts.js';

export function registerRoutes(app) {
  registerAuthRoutes(app);
  registerSystemRoutes(app);
  registerSiteRoutes(app);
  registerRuntimeRoutes(app);
  registerCertRoutes(app);
  registerTaskRoutes(app);
  registerLogRoutes(app);
  registerAlertRoutes(app);
  registerUserRoutes(app);
  registerSettingsRoutes(app);
  return app;
}
