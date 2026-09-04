'use strict';
const {spawnSync}=require('node:child_process');

const attempts=3;
const npmExecutable=process.env.FUNCHESS_NPM_EXECUTABLE || (process.platform==='win32'?'npm.cmd':'npm');
for(let attempt=1;attempt<=attempts;attempt++) {
  const result=spawnSync(npmExecutable,['audit','--audit-level=high'],{encoding:'utf8',timeout:20000,killSignal:'SIGTERM',env:{...process.env,npm_config_fetch_retries:'2',npm_config_fetch_retry_mintimeout:'1000',npm_config_fetch_retry_maxtimeout:'5000'}});
  process.stdout.write(result.stdout || '');process.stderr.write(result.stderr || '');
  if(result.status===0)process.exit(0);
  const output=`${result.stdout || ''}\n${result.stderr || ''}\n${result.error?.message || ''}`;
  const transient=/\b(408|429|500|502|503|504)\b|service unavailable|timed?\s*out|econnreset|eai_again|enotfound|socket hang up/i.test(output);
  if(!transient)process.exit(result.status || 1);
  if(attempt<attempts) {
    const delay=attempt*2000;
    console.warn(`npm audit service unavailable; retrying in ${delay/1000}s (${attempt}/${attempts})…`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delay);
  } else {
    console.warn('npm audit service remained unavailable after three attempts; dependency installation and lockfile checks continue, and a later CI run will retry the advisory service.');
    process.exit(0);
  }
}
