import { test } from '@playwright/test';
import { runWorkspaceDemo } from '../browser/support/workspace-demo';

test('разделение монолита и консоль на публичном развёртывании',async({page})=>{
  test.setTimeout(180000);
  await runWorkspaceDemo(page);
});
