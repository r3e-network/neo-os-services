let WorkflowEntrypointImpl = class WorkflowEntrypointFallback {
  constructor(ctx = {}, env = {}) {
    this.ctx = ctx;
    this.env = env;
  }
};

try {
  ({ WorkflowEntrypoint: WorkflowEntrypointImpl } = await import('cloudflare:workers'));
} catch {
  // Node-based tests do not understand the cloudflare:workers import scheme.
}

export { WorkflowEntrypointImpl as WorkflowEntrypoint };
