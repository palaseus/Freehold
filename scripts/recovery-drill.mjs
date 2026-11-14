import { writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';

const admin = new Client({ connectionString: process.env.DR_ADMIN_URL });
const api = new Client({ connectionString: process.env.DR_API_URL });
const worker = new Client({ connectionString: process.env.DR_WORKER_URL });
const output = process.env.DR_STATE_FILE;
const connect = async c => { await c.connect(); c.on('error', () => {}); };
const scalar = async (c, sql, args=[]) => (await c.query(sql,args)).rows[0];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
await Promise.all([connect(admin),connect(api),connect(worker)]);
let interrupted;
try {
  const actor = randomUUID();
  const reviewer = randomUUID();
  const beneficiary = randomUUID();
  await admin.query(`INSERT INTO freehold.users(id,email_normalized,password_hash,role)
    VALUES($1,$2,'test-only-unused-hash','ADMIN'),($3,$4,'test-only-unused-hash','ADMIN'),($5,$6,'test-only-unused-hash','USER')`,
  [actor,`recovery-${actor}@invalid.test`,reviewer,`recovery-reviewer-${reviewer}@invalid.test`,beneficiary,`recovery-${beneficiary}@invalid.test`]);
  await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)',[actor,'ACCOUNT_ADMIN','disposable recovery drill']);
  await admin.query('SELECT freehold.governance_provision_capability($1,$2,$3,true)',[reviewer,'FINANCIAL_REVIEWER','disposable recovery drill']);
  await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=true WHERE singleton');
  const bind = async userId => {
    const secret = randomBytes(32);
    await admin.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,NULL,3600)', [userId, secret]);
    return secret.toString('hex');
  };
  const actorSecret = await bind(actor);
  const reviewerSecret = await bind(reviewer);
  const beneficiarySecret = await bind(beneficiary);
  const asApi = async (secret, sql, args = []) => {
    await api.query('BEGIN');
    try {
      await api.query(`SELECT set_config('freehold.session_secret',$1,true)`, [secret]);
      const row = (await api.query(sql, args)).rows[0];
      await api.query('COMMIT');
      return row;
    } catch (error) {
      try { await api.query('ROLLBACK'); } catch { /* keep the posting error */ }
      throw error;
    }
  };
  const sourceResult = await asApi(actorSecret,'SELECT freehold.create_account($1,$2,$3,$4) AS result',[actor,'USD',`recovery-account-${randomUUID()}`,randomUUID()]);
  const destinationResult = await asApi(beneficiarySecret,'SELECT freehold.create_account($1,$2,$3,$4) AS result',[beneficiary,'USD',`recovery-account-${randomUUID()}`,randomUUID()]);
  const source = sourceResult.result.accountId;
  const destination = destinationResult.result.accountId;
  await asApi(actorSecret,'SELECT freehold.sandbox_fund_account($1,$2,10000,$3,$4,$5)',[actor,source,`recovery-fund-${randomUUID()}`,'Disposable recovery drill',randomUUID()]);
  await asApi(actorSecret,'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,100,$5,$6)',[actor,source,destination,'USD',`recovery-seed-transfer-${randomUUID()}`,randomUUID()]);
  const hold = await asApi(actorSecret,'SELECT freehold.reserve_funds($1,$2,25,$3,$4,NULL,$5) AS result',[actor,source,`recovery-reserve-${randomUUID()}`,'Recovery drill hold',randomUUID()]);
  await asApi(actorSecret,'SELECT freehold.release_hold($1,$2,$3,$4)',[actor,hold.result.holdId,`recovery-release-${randomUUID()}`,randomUUID()]);

  // Terminate the backend after the posting function returns but before COMMIT.
  const interruptedKey = `recovery-interrupted-${randomUUID()}`;
  const interruptedCorrelation = randomUUID();
  interrupted = new Client({ connectionString: process.env.DR_API_URL });
  await connect(interrupted);
  await interrupted.query('BEGIN');
  await interrupted.query(`SELECT set_config('freehold.session_secret',$1,true)`, [actorSecret]);
  const interruptedPid = (await scalar(interrupted,'SELECT pg_backend_pid() AS pid')).pid;
  let inFlightError = false;
  try {
    await interrupted.query('SELECT freehold.execute_internal_transfer($1,$2,$3,$4,7,$5,$6)',
      [actor,source,destination,'USD',interruptedKey,interruptedCorrelation]);
    await admin.query('SELECT pg_terminate_backend($1)',[interruptedPid]);
    await interrupted.query('COMMIT');
  } catch { inFlightError = true; }
  assert(inFlightError,'termination must interrupt the in-flight transaction');
  await interrupted.end().catch(()=>{});
  interrupted = null;
  const rolledBack = await scalar(admin,'SELECT count(*)::int AS count FROM freehold.idempotency_requests WHERE actor_id=$1 AND operation=\'TRANSFER\' AND key=$2',[actor,interruptedKey]);
  assert(rolledBack.count===0,'terminated pre-commit transfer must roll back completely');
  const retryResult = await asApi(actorSecret,'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,7,$5,$6) AS result',
    [actor,source,destination,'USD',interruptedKey,interruptedCorrelation]);
  const interruptedJournalCount = await scalar(admin,'SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1',[retryResult.result.operationId]);
  assert(interruptedJournalCount.count===1,'same-key retry after pre-commit termination must post once');

  // Commit, intentionally discard the first result, and preserve the retry tuple for post-restore replay.
  const lostAck = { actor, source, destination, currency: 'USD', amount: 9,
    key: `recovery-lost-ack-${randomUUID()}`, correlation: randomUUID() };
  const committed = await asApi(actorSecret,'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,$5,$6,$7) AS result',
    [lostAck.actor,lostAck.source,lostAck.destination,lostAck.currency,lostAck.amount,lostAck.key,lostAck.correlation]);
  lostAck.operationId = committed.result.operationId;
  lostAck.expectedResult = committed.result;
  // Worker crash after lease commit and before acknowledgment.
  const workerId1 = randomUUID();
  const claimed = await scalar(worker,'SELECT coalesce(jsonb_agg(to_jsonb(c)) FILTER (WHERE c.event_id IS NOT NULL),\'[]\'::jsonb) AS claims FROM freehold.worker_claim_outbox($1,1,5) c',[workerId1]);
  const claims = claimed.claims;
  assert(claims.length===1,'worker should acquire one event before simulated crash');
  const abandonedEventId = claims[0].event_id;
  await worker.end();
  await new Promise(resolve=>setTimeout(resolve,5300));
  const worker2 = new Client({ connectionString: process.env.DR_WORKER_URL });
  await connect(worker2);
  const reclaimedResult = await scalar(worker2,'SELECT coalesce(jsonb_agg(to_jsonb(c)) FILTER (WHERE c.event_id IS NOT NULL),\'[]\'::jsonb) AS claims FROM freehold.worker_claim_outbox($1,100,30) c',[randomUUID()]);
  const reclaimed = reclaimedResult.claims.find(c=>c.event_id===abandonedEventId);
  assert(reclaimed && Number(reclaimed.attempt_count)>=2,'expired lease should be reclaimed with an incremented attempt');
  for (const item of reclaimedResult.claims) await worker2.query('SELECT freehold.worker_complete_outbox($1,$2)',[item.worker_id,item.event_id]);
  const duplicateAck = await scalar(worker2,'SELECT freehold.worker_complete_outbox($1,$2) AS acknowledged',[reclaimed.worker_id,reclaimed.event_id]);
  assert(duplicateAck.acknowledged===false,'duplicate acknowledgment must not claim a second completion');

  // Kill a reconciliation transaction after its computed report was returned but before commit.
  await worker2.query('BEGIN');
  const reconciliationPid = (await scalar(worker2,'SELECT pg_backend_pid() AS pid')).pid;
  const pendingReport = await scalar(worker2,'SELECT freehold.worker_reconcile_and_record() AS report');
  const pendingRunId = pendingReport.report.reconciliationId;
  await admin.query('SELECT pg_terminate_backend($1)',[reconciliationPid]);
  await new Promise(resolve=>setTimeout(resolve,100));
  const rolledBackReport = await scalar(admin,'SELECT count(*)::int AS count FROM freehold.reconciliation_runs WHERE reconciliation_id=$1',[pendingRunId]);
  assert(rolledBackReport.count===0,'terminated reconciliation must not leave a partial report');
  await worker2.end();
  const worker3 = new Client({ connectionString: process.env.DR_WORKER_URL });
  await connect(worker3);
  const committedReport = await scalar(worker3,'SELECT freehold.worker_reconcile_and_record() AS report');
  await worker3.end();
  assert(committedReport.report.balanced===true,'restarted reconciliation should record a balanced report');

  // Persist an already executed dual-control request so restoration can prove it cannot execute twice.
  const governanceKey=`recovery-governance-${randomUUID()}`;
  const request=(await asApi(actorSecret,'SELECT freehold.governance_create_account_request($1,$2,true,$3,$4) AS result',
    [actor,source,'Recovery drill dual-control freeze',governanceKey])).result;
  await asApi(reviewerSecret,'SELECT freehold.governance_decide($1,$2,$3)',[reviewer,request.requestId,'APPROVE']);
  const governanceResult=(await asApi(actorSecret,'SELECT freehold.governance_execute($1,$2,$3,$4) AS result',
    [actor,request.requestId,governanceKey,randomUUID()])).result;
  assert(governanceResult.status==='EXECUTED','governance request must execute before backup');
  const governanceOperationId=(await scalar(admin,'SELECT operation_id FROM freehold.governance_requests WHERE id=$1',[request.requestId])).operation_id;
  await admin.query('UPDATE freehold.ledger_settings SET sandbox_enabled=false WHERE singleton');
  await writeFile(output,JSON.stringify({...lostAck,governanceActor:actor,governanceRequestId:request.requestId,
    governanceOperationKey:governanceKey,governanceOperationId,governanceResult},null,2)+'\n',{mode:0o600});
  process.stdout.write(JSON.stringify({ outcome:'RECOVERY_SCENARIOS_PASSED', preCommitTransfer:'ROLLED_BACK_THEN_RETRIED_ONCE', committedLostAckOperationId:lostAck.operationId, workerLease:'RECLAIMED_AND_ACKNOWLEDGED', reconciliation:'ABORTED_THEN_RERUN' })+'\n');
} finally {
  if (interrupted) await interrupted.end().catch(()=>{});
  await Promise.all([admin.end().catch(()=>{}),api.end().catch(()=>{}),worker.end().catch(()=>{})]);
}
