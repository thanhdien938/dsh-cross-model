import test from 'node:test';
import assert from 'node:assert/strict';
import {acceptanceSourceRef,acceptanceCheckoutClean} from './acceptance-source-snapshot.mjs';
const tree='a'.repeat(40),env={DSH_CANARY_SOURCE_TREE:tree};
const values={['cat-file -t '+tree]:'tree','write-tree':tree,'diff --name-only':'','ls-files --others --exclude-standard':''};
test('staged snapshot binds index, working files, untracked files and tree type',()=>{
  const git=(...args)=>values[args.join(' ')];
  assert.equal(acceptanceCheckoutClean(git,env),true);
  for(const [key,value] of [['write-tree','b'.repeat(40)],['diff --name-only','changed.mjs'],['ls-files --others --exclude-standard','untracked.mjs'],['cat-file -t '+tree,'commit']]) {
    assert.equal(acceptanceCheckoutClean((...args)=>args.join(' ')===key?value:git(...args),env),false);
  }
  assert.throws(()=>acceptanceSourceRef('base',{DSH_CANARY_SOURCE_TREE:'HEAD'}));
});
test('default preserves clean committed checkout requirement',()=>{
  assert.equal(acceptanceSourceRef('base',{}),'base');
  assert.equal(acceptanceCheckoutClean(()=>'',{}),true);
  assert.equal(acceptanceCheckoutClean(()=>' M changed',{}),false);
});
