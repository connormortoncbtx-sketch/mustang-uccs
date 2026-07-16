// scripts/push.js
// Usage: npm run push -- "commit message here"
// If no message is given, defaults to "update".

import { execSync } from 'child_process';

const msg = process.argv.slice(2).join(' ') || 'update';

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

run('git add -A');
run(`git commit -m "${msg.replace(/"/g, '\\"')}"`);
run('git push');
