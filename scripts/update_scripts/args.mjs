import { parseArgs } from "node:util";

const {
  values: { version }
} = parseArgs({
    args: Bun.argv,
    options: {
        version: {
            type: 'string',
            short: 'v',
            description: 'New version to set in PKGBUILD'
        }
    },
    strict: true,
    allowPositionals: true
});

if (!version) {
  console.error('Error: New version not provided. Usage: node prepare_release.mjs -v <new_version>');
  process.exit(1);
}

export { version };