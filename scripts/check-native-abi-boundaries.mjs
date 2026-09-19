import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const matrix = JSON.parse(readFileSync(resolve(root, 'config/native-abi-matrix.json'), 'utf8'));
const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const desktopPackage = JSON.parse(readFileSync(resolve(root, 'desktop/package.json'), 'utf8'));
const role = process.argv.includes('--require-installed') ? process.argv[process.argv.indexOf('--require-installed') + 1] : null;

function fail(message, code = 'NATIVE_ABI_CONTRACT_FAILED') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertStaticContract() {
  if (rootPackage.dependencies['better-sqlite3'] !== matrix.rootNodeRuntime.betterSqlite3) fail('root better-sqlite3 does not match ABI matrix');
  if (desktopPackage.dependencies['better-sqlite3'] !== matrix.desktopNodeTests.betterSqlite3) fail('Desktop better-sqlite3 does not match ABI matrix');
  if (desktopPackage.devDependencies.electron !== matrix.desktopElectron.electron) fail('Electron does not match ABI matrix');
  if (rootPackage.dependencies.pg !== desktopPackage.dependencies.pg) fail('root/Desktop pg versions must stay aligned');
}

function verifyInstalledTree(kind) {
  const packageDirectory = kind === 'root' ? root : resolve(root, 'desktop');
  const expectedModules = resolve(packageDirectory, 'node_modules');
  const requireFromRole = createRequire(resolve(packageDirectory, 'package.json'));
  let entry;
  try { entry = requireFromRole.resolve('better-sqlite3'); }
  catch { fail(`${kind} better-sqlite3 is not installed locally`, 'NATIVE_ABI_DEPENDENCY_MISSING'); }
  const pathFromExpectedTree = relative(expectedModules, entry);
  if (pathFromExpectedTree.startsWith(`..${sep}`) || pathFromExpectedTree === '..') fail(`${kind} better-sqlite3 resolved outside its private node_modules tree`, 'NATIVE_ABI_ACCIDENTAL_HOISTING');
  try {
    const Database = requireFromRole('better-sqlite3');
    const database = new Database(':memory:');
    database.prepare('SELECT 1').get();
    database.close();
  } catch (cause) {
    fail(`${kind} better-sqlite3 cannot load in Node ${process.version} ABI ${process.versions.modules}; rebuild this private tree for Node before tests (${cause.code || 'load failure'})`, 'NATIVE_ABI_LOAD_FAILED');
  }
  return entry;
}

try {
  assertStaticContract();
  const installed = {};
  if (role === 'root' || role === 'both') installed.root = verifyInstalledTree('root');
  if (role === 'desktop' || role === 'both') installed.desktop = verifyInstalledTree('desktop');
  if (role && !['root', 'desktop', 'both'].includes(role)) fail('expected --require-installed root|desktop|both', 'NATIVE_ABI_ARGUMENT_INVALID');
  console.log(JSON.stringify({ status: 'PASS', node: process.version, nodeModuleAbi: Number(process.versions.modules), checkedInstalledRole: role, installed }));
} catch (error) {
  console.error(JSON.stringify({ status: 'FAIL', code: error.code || 'NATIVE_ABI_CONTRACT_FAILED', message: error.message }));
  process.exitCode = 1;
}
