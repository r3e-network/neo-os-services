#!/usr/bin/env node
import pkg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const { Client } = pkg;

function pgTypeToTs(udtName) {
  switch (udtName) {
    case 'text':
    case 'varchar':
    case 'char':
    case 'bpchar':
      return 'string';
    case 'uuid':
      return 'string';
    case 'int2':
    case 'int4':
    case 'int8':
      return 'number';
    case 'float4':
    case 'float8':
      return 'number';
    case 'numeric':
      return 'number';
    case 'bool':
      return 'boolean';
    case 'timestamp':
    case 'timestamptz':
    case 'date':
      return 'string';
    case 'json':
    case 'jsonb':
      return 'Json';
    case 'bytea':
      return 'string';
    default:
      return 'unknown';
  }
}

async function main() {
  const outputPath = process.argv[2] || path.resolve('apps/web/lib/supabase-types.ts');
  const dbUrl =
    process.env.SUPABASE_TYPES_DB_URL || 'postgresql://postgres@localhost:5434/morpheus';

  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const columnsResult = await client.query(`
    SELECT
      c.table_name,
      c.column_name,
      c.udt_name,
      c.is_nullable,
      c.column_default
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name LIKE 'morpheus_%'
    ORDER BY c.table_name, c.ordinal_position
  `);

  const enumsResult = await client.query(`
    SELECT t.typname AS enum_name, e.enumlabel AS enum_value
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder
  `);

  await client.end();

  const tables = {};
  for (const row of columnsResult.rows) {
    if (!tables[row.table_name]) tables[row.table_name] = [];
    tables[row.table_name].push(row);
  }

  const enums = {};
  for (const row of enumsResult.rows) {
    if (!enums[row.enum_name]) enums[row.enum_name] = [];
    enums[row.enum_name].push(row.enum_value);
  }

  const tableEntries = [];
  for (const [tableName, columns] of Object.entries(tables)) {
    const rowFields = [];
    const insertFields = [];
    const updateFields = [];

    for (const col of columns) {
      const tsType = pgTypeToTs(col.udt_name);
      const nullable = col.is_nullable === 'YES';
      const hasDefault = col.column_default !== null;
      const optional = nullable || hasDefault;
      const suffix = nullable ? ' | null' : '';

      rowFields.push(`      ${col.column_name}: ${tsType}${suffix};`);
      insertFields.push(`      ${col.column_name}${optional ? '?' : ''}: ${tsType}${suffix};`);
      updateFields.push(`      ${col.column_name}?: ${tsType}${suffix};`);
    }

    tableEntries.push(`    ${tableName}: {
      Row: {
${rowFields.join('\n')}
      };
      Insert: {
${insertFields.join('\n')}
      };
      Update: {
${updateFields.join('\n')}
      };
      Relationships: never[];
    };`);
  }

  const enumEntries = [];
  for (const [enumName, values] of Object.entries(enums)) {
    enumEntries.push(`      ${enumName}: ${values.map((v) => `'${v}'`).join(' | ')};`);
  }

  const output = `// Auto-generated from \`db/services/migrations/\` via a temporary PostgreSQL instance.
// Do not edit manually. Regenerate after schema changes using the documented
// workflow in \`docs/DEVELOPMENT.md\`.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
${tableEntries.join('\n')}
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
${enumEntries.join('\n') || '      // no enums'}
    };
    CompositeTypes: Record<string, never>;
  };
}
`;

  fs.writeFileSync(outputPath, output, 'utf8');
  console.log(`Wrote ${Object.keys(tables).length} tables to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
