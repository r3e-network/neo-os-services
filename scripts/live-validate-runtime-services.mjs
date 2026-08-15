#!/usr/bin/env node

import { main } from './runtime-service-matrix.mjs';

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
