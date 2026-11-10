import { strict as assert } from 'node:assert';
import { backgroundTasks } from '../server/services/backgroundTasks.js';

let passed = 0;
let failed = 0;

function check(label, ok, extra = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}${extra ? ` (${extra})` : ''}`);
  }
}

async function run() {
  console.log('\n== Background Task Manager Unit & Integration Tests ==');

  // 1. Start a simple command
  const t1 = backgroundTasks.startTask({
    command: 'node -e "console.log(\'hello from background task\');"',
    name: 'Quick Echo'
  });

  check('Task started with ID and status running', t1.id && (t1.status === 'running' || t1.status === 'completed'));

  // 2. Wait timer for quick command to finish
  const res1 = await backgroundTasks.waitTaskTimer(t1.id, 3);
  check('waitTaskTimer resolves after completion', res1.status === 'completed', `status=${res1.status}`);
  check('Captured stdout output contains message', res1.outputTail.includes('hello from background task'));

  // 3. Start a longer-running task
  const t2 = backgroundTasks.startTask({
    command: 'node -e "setInterval(function(){ console.log(\'tick\'); }, 200);"',
    name: 'Slow Task'
  });

  check('Slow task starts running', t2.status === 'running');
  check('Running count reflects active task', backgroundTasks.runningCount() >= 1);

  // 4. Timer check while still running
  const res2 = await backgroundTasks.waitTaskTimer(t2.id, 1);
  check('waitTaskTimer returns running state when timer expires', res2.status === 'running', `status=${res2.status}`);
  check('Running task duration reported', res2.durationMs >= 800);

  // 5. List tasks
  const list = backgroundTasks.listTasks({ all: true });
  const found = list.find((x) => x.id === t2.id);
  check('listTasks finds the active task', !!found && found.status === 'running');

  // 6. Kill task
  const killRes = backgroundTasks.killTask(t2.id);
  check('killTask succeeds', killRes.ok === true && killRes.status === 'killed');

  const afterKill = backgroundTasks.getTask(t2.id);
  check('Task status is now killed', afterKill.status === 'killed');

  console.log(`\nResults: ${passed} passed, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
