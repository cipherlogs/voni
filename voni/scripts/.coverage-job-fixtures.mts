import { readFileSync,writeFileSync } from 'node:fs';
import { createJob,claimJob,failJob } from '../src/lib/jobs/store';
const file='/tmp/voni-coverage-fixtures.json';const fixture=JSON.parse(readFileSync(file,'utf8'));
for(const scenario of ['retry','cancel','away']) {
 const {job}=await createJob({organizationId:'dev-bypass-org',creatorId:'dev-bypass-user',kind:'record_search',title:`Coverage recovery ${scenario}`,idempotencyKey:`coverage-${scenario}-${Date.now()}`,input:{kind:'leads',query:fixture.prefix},targetUrl:'/jobs'});
 fixture.jobs.push(job.id);fixture[scenario+'Job']=job.id;
 if(scenario==='retry'){await claimJob(job.id,60000);await failJob(job.id,'transport','Simulated connection failure for coverage verification.');}
}
writeFileSync(file,JSON.stringify(fixture));console.log('Prepared isolated queued and failed jobs for recovery checks.');
