/**
 * HTTP 内核：路由 + 上下文 + 静态资源 + 统一错误信封 + SSE。
 *
 * 不用 Express 的原因：面板只需要 300 行左右的能力，零依赖能显著降低
 * VPS 部署成本（无 node_modules、无原生模块编译），也减少供应链风险。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';
import { HttpError, toHttpError, successBody, errorBody } from './errors.js';
import { config } from '../config.js';
import { uuid } from './crypto.js';

const log = createLogger('http');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
};

function compilePattern(pattern) {
  const keys = [];
  const regexStr = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${regexStr}$`), keys };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[k] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

async function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError('VALIDATION_FAILED', { message: '请求体过大' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp() {
  const routes = [];
  const middlewares = [];

  const add = (method, pattern, handlers) => {
    const { regex, keys } = compilePattern(pattern);
    routes.push({ method, regex, keys, handlers: handlers.flat(), pattern });
  };

  const app = {
    use(fn) {
      middlewares.push(fn);
      return app;
    },
    get: (p, ...h) => (add('GET', p, h), app),
    post: (p, ...h) => (add('POST', p, h), app),
    patch: (p, ...h) => (add('PATCH', p, h), app),
    put: (p, ...h) => (add('PUT', p, h), app),
    delete: (p, ...h) => (add('DELETE', p, h), app),
    routes,
  };

  async function buildContext(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const ip =
      (config.trustProxy && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
      req.socket.remoteAddress ||
      '';
    const ctx = {
      req,
      res,
      method: req.method,
      pathname: decodeURIComponent(url.pathname),
      query: Object.fromEntries(url.searchParams.entries()),
      params: {},
      headers: req.headers,
      ip: ip.replace(/^::ffff:/, ''),
      ua: String(req.headers['user-agent'] || '').slice(0, 300),
      requestId: uuid(),
      cookies: parseCookies(req.headers.cookie),
      body: undefined,
      user: null,
      session: null,
      locals: {},
    };

    ctx.setCookie = (name, value, opts = {}) => {
      const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
      if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
      if (opts.secure) parts.push('Secure');
      if (opts.expires) parts.push(`Expires=${new Date(opts.expires).toUTCString()}`);
      const prev = res.getHeader('Set-Cookie');
      const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
      list.push(parts.join('; '));
      res.setHeader('Set-Cookie', list);
    };

    ctx.clearCookie = (name) => {
      ctx.setCookie(name, '', { maxAge: 0 });
    };

    ctx.json = (data, status = 200) => {
      return { __response: { type: 'json', status, body: data } };
    };

    ctx.text = (text, status = 200) => ({
      __response: { type: 'text', status, body: text },
    });

    /** SSE：返回 { send(event, data), close() } */
    ctx.sse = () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...SECURITY_HEADERS,
      });
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 15000);
      let closed = false;
      res.on('close', () => {
        closed = true;
        clearInterval(heartbeat);
      });
      return {
        send(event, data) {
          if (closed) return false;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          return true;
        },
        close() {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          res.end();
        },
      };
    };

    ctx.audit = (action, { resource, resourceId, detail, result = 'success' } = {}) => {
      ctx.locals.audit = { action, resource, resourceId, detail, result };
    };

    return ctx;
  }

  async function serveStatic(ctx) {
    const urlPath = ctx.pathname === '/' ? '/index.html' : ctx.pathname;
    const safeRel = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
    let filePath = path.join(config.webDir, safeRel);

    if (!filePath.startsWith(config.webDir)) {
      return { status: 403, body: 'Forbidden' };
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA 回退：非静态资源路径交给前端路由
      if (!path.extname(urlPath)) {
        filePath = path.join(config.webDir, 'index.html');
      } else {
        return { status: 404, body: 'Not Found' };
      }
    }
    if (!fs.existsSync(filePath)) return { status: 404, body: 'Not Found' };

    const ext = path.extname(filePath).toLowerCase();
    const content = fs.readFileSync(filePath);
    return {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      },
      body: content,
    };
  }

  async function handle(req, res) {
    const ctx = await buildContext(req, res);
    const started = Date.now();

    res.setHeader('X-Request-Id', ctx.requestId);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    try {
      // 1) 路由匹配
      let matched = null;
      let params = {};
      let methodMismatch = false;
      for (const route of routes) {
        const m = route.regex.exec(ctx.pathname);
        if (!m) continue;
        if (route.method !== ctx.method && !(route.method === 'GET' && ctx.method === 'HEAD')) {
          methodMismatch = true;
          continue;
        }
        matched = route;
        route.keys.forEach((key, i) => { params[key] = decodeURIComponent(m[i + 1]); });
        break;
      }
      ctx.params = params;

      if (!matched) {
        // 静态资源与前端路由
        if (ctx.method === 'GET' || ctx.method === 'HEAD') {
          const file = await serveStatic(ctx);
          res.writeHead(file.status, file.headers || {});
          res.end(req.method === 'HEAD' ? undefined : file.body);
          return;
        }
        throw methodMismatch ? new HttpError('NOT_FOUND', { message: '接口不存在' }) : new HttpError('NOT_FOUND', { message: '接口不存在' });
      }

      // 2) 请求体
      const hasBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method);
      if (hasBody && String(ctx.headers['content-type'] || '').includes('application/json')) {
        const raw = await readBody(req, config.bodyLimitBytes);
        if (raw.length) {
          try {
            ctx.body = JSON.parse(raw.toString('utf8'));
          } catch {
            throw new HttpError('VALIDATION_FAILED', { message: '请求体不是合法 JSON' });
          }
        } else {
          ctx.body = {};
        }
      } else if (hasBody) {
        ctx.body = {};
      }

      // 3) 全局中间件（鉴权 / CSRF / 限流 …）
      for (const mw of middlewares) {
        await mw(ctx);
      }

      // 4) 业务处理
      let result;
      for (const handler of matched.handlers) {
        result = await handler(ctx);
        if (result !== undefined) break;
      }

      if (result && result.__response) {
        const { type, status, body } = result.__response;
        if (type === 'json') {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(body));
        } else {
          res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(body);
        }
        return;
      }
      if (res.headersSent) return;
      if (result === undefined) {
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(successBody(result)));
    } catch (err) {
      const httpErr = toHttpError(err);
      const isServerError = httpErr.status >= 500;
      if (isServerError) {
        log.error(`${ctx.method} ${ctx.pathname} 处理失败`, {
          code: httpErr.code,
          message: httpErr.message,
          stack: httpErr.cause?.stack || err.stack,
          requestId: ctx.requestId,
        });
      }
      if (!res.headersSent) {
        res.writeHead(httpErr.status, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      res.end(JSON.stringify(errorBody(httpErr, ctx.requestId)));
    } finally {
      const cost = Date.now() - started;
      if (!ctx.pathname.startsWith('/assets') && cost > 800) {
        log.warn(`慢请求 ${ctx.method} ${ctx.pathname} ${cost}ms`);
      }
    }
  }

  return { app, handle };
}

export function startServer({ app, handle }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('未捕获的请求异常', { stack: err?.stack || String(err) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  server.headersTimeout = 20000;
  server.requestTimeout = 120000;
  server.keepAliveTimeout = 65000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.bind, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}
