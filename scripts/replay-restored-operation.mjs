import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
const state = JSON.parse(await readFile(process.env.DR_STATE_FILE,'utf8'));
const client = new Client({ connectionString: process.env.DR_RESTORE_API_URL });
const admin = new Client({ connectionString: process.env.DR_RESTORE_ADMIN_URL });
await client.connect();
await admin.connect();
const bind = async userId => {
  const secret = randomBytes(32);
  await admin.query('SELECT freehold.auth_bind_session($1::uuid,1,$2::bytea,NULL,3600)', [userId, secret]);
  return secret.toString('hex');
};
const asApi = async (secret, sql, args) => {
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('freehold.session_secret',$1,true)`, [secret]);
    const row = (await client.query(sql, args)).rows[0];
    await client.query('COMMIT');
    return row;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep the replay error */ }
    throw error;
  }
};
try {
  const actorSecret = await bind(state.actor);
  const governanceSecret = await bind(state.governanceActor);
  const result = (await asApi(actorSecret,'SELECT freehold.execute_internal_transfer($1,$2,$3,$4,$5,$6,$7) AS result',
    [state.actor,state.source,state.destination,state.currency,state.amount,state.key,state.correlation])).result;
  assert.deepEqual(result,state.expectedResult,'restored same-key replay must return the exact committed response');
  const rows = (await admin.query('SELECT count(*)::int AS count FROM freehold.ledger_journals WHERE operation_id=$1',[state.operationId])).rows[0].count;
  assert.equal(rows,1,'restored same-key replay must preserve one journal only');
  const governance = (await asApi(governanceSecret,'SELECT freehold.governance_execute($1,$2,$3,$4) AS result',
    [state.governanceActor,state.governanceRequestId,state.governanceOperationKey,randomUUID()])).result;
  assert.deepEqual(governance,state.governanceResult,'restored executed approval must return its durable original result');
  const request = (await admin.query('SELECT status,operation_id FROM freehold.governance_requests WHERE id=$1',[state.governanceRequestId])).rows[0];
  assert.equal(request.status,'EXECUTED','restored governance request remains terminal');
  assert.equal(request.operation_id,state.governanceOperationId);
  const actionCount=(await admin.query('SELECT count(*)::int AS count FROM freehold.admin_actions WHERE operation_id=$1',[state.governanceOperationId])).rows[0].count;
  assert.equal(actionCount,1,'restored approval replay must not perform the account action a second time');
  process.stdout.write(JSON.stringify({ outcome:'RESTORED_IDEMPOTENCY_AND_GOVERNANCE_REPLAY_PASSED', operationId:state.operationId, journalCount:rows, governanceRequestId:state.governanceRequestId, governanceStatus:request.status, governanceActionCount:actionCount })+'\n');
} finally { await Promise.all([client.end(),admin.end()]); }
