#!/usr/bin/env node

import { inspectWebCronEnv } from './lib-web-cron-env.mjs';

const result = await inspectWebCronEnv();
console.log(JSON.stringify(result, null, 2));

if (!result.ok && process.argv.includes('--fail-on-missing')) {
  process.exit(1);
}
