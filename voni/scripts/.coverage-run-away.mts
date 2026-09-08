import {readFileSync} from 'node:fs';
import {runJob} from '../src/lib/jobs/processor';
import {getJob} from '../src/lib/jobs/store';
const f=JSON.parse(readFileSync('/tmp/voni-coverage-fixtures.json','utf8'));
await runJob(f.awayJob);
const job=await getJob('dev-bypass-org','dev-bypass-user',f.awayJob);
console.log('Away job status:',job?.status);
