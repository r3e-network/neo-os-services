test:
  environment: node
  coverage:
    provider: v8
    all: true
    exclude:
      - '**/*.test.ts'
      - 'src/**/index.ts'
      - '**/*.d.ts'
      - 'vitest.config.ts'
