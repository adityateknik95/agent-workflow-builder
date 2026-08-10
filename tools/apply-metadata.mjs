// Applies nhost/metadata to a running Hasura without needing the Hasura CLI.
//
// Two things are worth knowing about how this works:
//
//  1. The metadata directory is in the Hasura CLI's own layout ("!include" and
//     actions.graphql + actions.yaml), so `hasura metadata apply` and an nhost
//     deploy consume the exact same files. This script just resolves those files
//     itself and posts the result to /v1/metadata.
//
//  2. It merges rather than overwrites. hasura-auth tracks its own tables in the
//     `auth` schema, and on nhost those are managed by the platform. So we keep
//     every tracked table outside `public` as-is and replace only ours.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import YAML from 'yaml';
import { parse as parseGraphQL, print } from 'graphql';
import 'dotenv/config';

const METADATA_DIR = join(import.meta.dirname, '..', 'nhost', 'metadata');
const ENDPOINT = process.env.HASURA_GRAPHQL_ENDPOINT || 'http://localhost:8080';
const ADMIN_SECRET = process.env.HASURA_GRAPHQL_ADMIN_SECRET;

if (!ADMIN_SECRET) {
  console.error('HASURA_GRAPHQL_ADMIN_SECRET is not set. Copy .env.example to .env first.');
  process.exit(1);
}

// --- "!include other.yaml" resolution ---------------------------------------
function loadYaml(file) {
  return resolveIncludes(YAML.parse(readFileSync(file, 'utf8')), dirname(file));
}

function resolveIncludes(node, baseDir) {
  if (typeof node === 'string') {
    const match = /^!include\s+(.+)$/.exec(node.trim());
    return match ? loadYaml(resolve(baseDir, match[1])) : node;
  }
  if (Array.isArray(node)) return node.map((item) => resolveIncludes(item, baseDir));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, resolveIncludes(v, baseDir)]));
  }
  return node;
}

// --- actions: definitions from actions.yaml, types from actions.graphql ------
function buildActions() {
  const yamlPath = join(METADATA_DIR, 'actions.yaml');
  const sdlPath = join(METADATA_DIR, 'actions.graphql');
  const config = YAML.parse(readFileSync(yamlPath, 'utf8')) ?? {};
  const doc = parseGraphQL(readFileSync(sdlPath, 'utf8'));

  const fieldsByName = new Map();
  const objects = [];
  const enums = [];
  const inputObjects = [];
  const scalars = [];

  for (const def of doc.definitions) {
    if (def.kind === 'ObjectTypeDefinition' && (def.name.value === 'Mutation' || def.name.value === 'Query')) {
      for (const field of def.fields ?? []) {
        fieldsByName.set(field.name.value, {
          type: def.name.value.toLowerCase(),
          output_type: print(field.type),
          arguments: (field.arguments ?? []).map((arg) => ({
            name: arg.name.value,
            type: print(arg.type),
          })),
        });
      }
    } else if (def.kind === 'ObjectTypeDefinition') {
      objects.push({
        name: def.name.value,
        fields: (def.fields ?? []).map((f) => ({ name: f.name.value, type: print(f.type) })),
      });
    } else if (def.kind === 'EnumTypeDefinition') {
      enums.push({
        name: def.name.value,
        values: (def.values ?? []).map((v) => ({ value: v.name.value })),
      });
    } else if (def.kind === 'InputObjectTypeDefinition') {
      inputObjects.push({
        name: def.name.value,
        fields: (def.fields ?? []).map((f) => ({ name: f.name.value, type: print(f.type) })),
      });
    } else if (def.kind === 'ScalarTypeDefinition') {
      scalars.push({ name: def.name.value });
    }
  }

  const actions = (config.actions ?? []).map((action) => {
    const sdl = fieldsByName.get(action.name);
    if (!sdl) throw new Error(`action "${action.name}" has no matching field in actions.graphql`);
    return {
      name: action.name,
      comment: action.comment,
      definition: { ...action.definition, ...sdl },
      permissions: action.permissions ?? [],
    };
  });

  return { actions, custom_types: { objects, enums, input_objects: inputObjects, scalars } };
}

async function metadataApi(type, args) {
  const res = await fetch(`${ENDPOINT}/v1/metadata`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hasura-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ type, args }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${type} failed:\n${JSON.stringify(body, null, 2)}`);
  }
  return body;
}

// --- compose -----------------------------------------------------------------
const sources = loadYaml(join(METADATA_DIR, 'databases', 'databases.yaml'));
const cronTriggers = loadYaml(join(METADATA_DIR, 'cron_triggers.yaml')) ?? [];
const { actions, custom_types } = buildActions();

const current = await metadataApi('export_metadata', {});
const currentSource = (current.sources ?? []).find((s) => s.name === 'default');
const foreignTables = (currentSource?.tables ?? []).filter((t) => t.table.schema !== 'public');

for (const source of sources) {
  source.tables = [...foreignTables, ...(source.tables ?? [])];
}

const metadata = {
  version: 3,
  sources,
  actions,
  custom_types,
  cron_triggers: cronTriggers,
};

const managed = sources[0].tables.length - foreignTables.length;
console.log(
  `applying metadata: ${managed} public tables (+${foreignTables.length} kept from auth), ` +
    `${actions.length} actions, ${cronTriggers.length} cron trigger(s)`
);

await metadataApi('replace_metadata', {
  allow_inconsistent_metadata: false,
  metadata,
});

const inconsistent = await metadataApi('get_inconsistent_metadata', {});
if (inconsistent.is_consistent === false) {
  console.error('metadata is inconsistent:');
  console.error(JSON.stringify(inconsistent.inconsistent_objects, null, 2));
  process.exit(1);
}

console.log('metadata applied and consistent.');
