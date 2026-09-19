// A staged tree permits validation before committing, while still binding the
// live run to exactly the offline-tested files. No dirty/untracked source bypass.
export function acceptanceSourceRef(base, env = process.env) {
  const ref = env.DSH_CANARY_SOURCE_TREE;
  if (ref === undefined) return base;
  if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error('INVALID_ACCEPTANCE_SOURCE_TREE');
  return ref;
}
export function acceptanceCheckoutClean(git, env = process.env) {
  if (env.DSH_CANARY_SOURCE_TREE === undefined) return git('status','--porcelain') === '';
  const ref = acceptanceSourceRef(null,env);
  return git('cat-file','-t',ref) === 'tree' && git('write-tree') === ref
    && git('diff','--name-only') === ''
    && git('ls-files','--others','--exclude-standard') === '';
}
export function acceptanceTestedTree(git, env = process.env) {
  return acceptanceSourceRef(git('rev-parse','HEAD^{tree}'),env);
}
