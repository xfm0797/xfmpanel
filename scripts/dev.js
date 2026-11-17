#!/usr/bin/env node
/**
 * 开发模式启动器：强制 XFMP_ENV=dev（stub agent + ./data），并透传额外参数。
 *
 *   npm run dev
 *   npm run dev -- --port 9000
 *
 * 之所以不直接在 package.json 里设环境变量，是为了兼容 Windows（cmd 不支持 FOO=bar 前缀）。
 */

import process from 'node:process';

process.env.XFMP_ENV = process.env.XFMP_ENV || 'dev';
process.env.XFMP_AGENT_MODE = process.env.XFMP_AGENT_MODE || 'stub';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--port' && args[i + 1]) {
    process.env.XFMP_PORT = args[i + 1];
    i += 1;
  } else if (args[i] === '--bind' && args[i + 1]) {
    process.env.XFMP_BIND = args[i + 1];
    i += 1;
  }
}

await import('../panel/src/server.js');
