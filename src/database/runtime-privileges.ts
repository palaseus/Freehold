import type { PoolClient } from 'pg';

const apiFunctions = [
  'auth_get_user/1', 'auth_lock_user/1',
  'demo_bootstrap_admin/4', 'auth_user_email/1', 'governance_admin_list_accounts/3',
  'governance_read_reconciliation/1','governance_read_audit/2','execute_internal_transfer/7',
  'reserve_funds/7', 'release_hold/4', 'sandbox_fund_account/6', 'create_account/4',
  'governance_create_account_request/5','governance_create_resume_request/3','governance_decide/3',
  'governance_cancel/2','governance_execute/4','governance_suspend_writes/2','governance_status/1','governance_overview/1',
  'governance_record_authorization_failure/4','governance_record_execution_failure/3',
  'account_statement/7','account_applicable_limits/2','governance_create_risk_policy_request/4',
  'risk_flags_list/2','risk_policies_list/1','risk_note_conflict/3',
  'compliance_open_case/5','compliance_transition/4','compliance_add_note/3','compliance_link/5',
  'compliance_list/2','compliance_get/2','institutional_report/1',
  'account_controls_get/2','account_controls_set/3','trusted_destination_add/3',
  'scheduled_transfer_create/8','scheduled_transfer_cancel/2','scheduled_transfer_list/2',
  'gl_report/3','operations_health/1',
  'customer_account_list/1','customer_account_get/2','customer_account_owns/2',
  'customer_account_activity/5','customer_idempotency_get/3','customer_operation_result/2',
  'monitor_evaluate/1','alert_list/2','alert_acknowledge/2',
  'incident_open/4','incident_update/4','incident_list/2','incident_get/2',
  'runtime_posture/0', 'deployment_posture/1',
  'monetary_overview/1', 'monetary_customer_activity/1', 'monetary_bank_open/3', 'monetary_bank_event/7',
  'monetary_issue_request/5', 'monetary_issue_verify/2', 'monetary_issue_approve/2', 'monetary_issue_execute/2',
  'monetary_issue_mark_unknown/2', 'monetary_issue_resolve_unknown/2',
  'monetary_redeem_request/4', 'monetary_redeem_settlement/3', 'monetary_redeem_finalize/2',
  'monetary_redeem_mark_unknown/2', 'monetary_redeem_resolve_unknown/2',
  'monetary_reserve_propose/7', 'monetary_reserve_review/3', 'monetary_reserve_encumber/3', 'monetary_reserve_mark_stale/2',
  'monetary_grant_capability/3', 'monetary_suspend/3', 'monetary_cap_request/4', 'monetary_cap_approve/2',
  'monetary_report_draft/4', 'monetary_report_transition/3', 'monetary_activate_live/1',
  'monetary_chain_observe/7', 'monetary_chain_reorg/2', 'monetary_fhu_issue/4', 'monetary_screen/3',
  'monetary_conversion_request/4', 'monetary_restriction_set/4', 'monetary_freeze_units/5',
  'monetary_record_capital/3', 'monetary_alert_acknowledge/2',
  'monetary_disclosure_acknowledge/3', 'monetary_institution_dashboard/1',
  'monetary_evidence_open/9', 'monetary_evidence_note/3', 'monetary_evidence_export/1',
  'monetary_partner_open/3', 'monetary_partner_check/3', 'monetary_partner_list/1',
  'institution_open/3', 'institution_grant/4', 'institution_policy_set/4',
  'institution_credential_issue/4', 'institution_credential_revoke/3',
  'institution_customer_open/5', 'institution_fund_simulated/6', 'institution_transfer/10',
  'institution_account_get/6', 'institution_activity/3', 'institution_treasury_open/5',
  'institution_treasury_report/5', 'institution_payment_open/11', 'institution_payment_transition/9',
  'institution_risk_run/3', 'institution_webhook_open/3', 'institution_webhook_subscribe/4',
  'institution_webhook_attempt/5', 'institution_webhook_rotate/3',
  'institution_dispute_open/4', 'institution_dispute_note/4', 'institution_dispute_resolve/5',
  'institution_adjustment_propose/6', 'institution_adjustment_post/3',
  'institution_billing_plan/7', 'institution_usage_record/6', 'institution_invoice_draft/6',
  'institution_billing_forecast/3', 'institution_compliance_open/3', 'institution_issuance_link/3',
  'institution_list/1', 'institution_health/2', 'institution_activate_live/1',
  'network_rulebook_propose/3', 'network_rulebook_adopt/2', 'network_member_apply/2', 'network_member_transition/3',
  'network_rulebook_accept/3', 'network_member_currencies/3', 'network_certificate_register/5', 'network_certificate_revoke/3', 'network_certificate_public/2',
  'network_liquidity_set/5', 'network_payment_open/13', 'network_payment_validate/2', 'network_payment_cancel/2',
  'network_payment_reject/2', 'network_payment_get/3', 'network_cycle_build/4', 'network_cycle_finalize/2', 'network_cycle_get/2',
  'network_settlement_submit/2', 'network_settlement_confirm/3', 'network_settlement_unknown/2', 'network_settlement_finalize/2',
  'network_settlement_reverse/2', 'network_message_record/5', 'network_dashboard/1', 'network_stress/3', 'network_activate_live/1',
  'program_policy_draft/9', 'program_policy_approve/2', 'program_policy_retire/2',
  'program_workflow_draft/8', 'program_workflow_submit/2', 'program_workflow_approve/2', 'program_workflow_cancel/2',
  'program_workflow_preview/2', 'program_workflow_get/2', 'program_workflow_execute/3',
  'program_escrow_fund/9', 'program_escrow_release/3', 'program_escrow_return/3', 'program_escrow_dispute/2',
  'program_settle_atomic/5', 'program_settle_coordinate/4', 'program_execution_unknown/2', 'program_fusd_request/6',
  'program_treasury_recommend/7', 'program_treasury_approve/2', 'program_treasury_execute/3', 'program_treasury_monitor/2',
  'program_asset_register/5', 'program_asset_authorize/2', 'program_asset_issue/5', 'program_asset_transfer/6',
  'program_asset_hold/5', 'program_asset_release/5', 'program_asset_redeem/5', 'program_asset_retire/4',
  'program_exchange_admit/2', 'program_quote_open/8', 'program_quote_execute/5',
  'program_collateral_pledge/6', 'program_collateral_release/2', 'program_collateral_substitute/4', 'program_collateral_default/2',
  'program_suspend/3', 'program_dashboard/1', 'program_activate_live/1',
];
const workerFunctions = ['worker_claim_outbox/3', 'worker_complete_outbox/2', 'worker_complete_outbox_batch/2', 'worker_reconcile_and_record/0', 'worker_backlog_status/0', 'worker_defer_outbox/3', 'worker_record_heartbeat/2', 'runtime_posture/0', 'institution_outbox_claim/2', 'institution_outbox_complete/2', 'network_outbox_claim/2', 'network_outbox_complete/2', 'program_workflow_run_due/2'];
const authFunctions = ['auth_find_credentials/1', 'auth_bind_session/5', 'auth_revoke_session/1', 'register_user/3', 'runtime_posture/0'];
const schedulerFunctions = ['scheduler_run_due/1', 'scheduler_record_heartbeat/1', 'runtime_posture/0'];
const apiTables = ['currencies'];

export async function assertRuntimePrivileges(client: PoolClient, runtime: 'api' | 'worker' | 'auth' | 'scheduler'): Promise<void> {
  const expectedRole = runtime === 'api' ? 'freehold_api' : runtime === 'worker' ? 'freehold_worker' : runtime === 'auth' ? 'freehold_auth' : 'freehold_scheduler';
  const functions = runtime === 'api' ? apiFunctions : runtime === 'worker' ? workerFunctions : runtime === 'auth' ? authFunctions : schedulerFunctions;
  const tables = runtime === 'api' ? apiTables : [];
  const { rows } = await client.query<{ valid: boolean }>(`
    WITH role_state AS (
      SELECT r.oid,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
             r.rolbypassrls,r.rolinherit,pg_is_in_recovery() AS standby
      FROM pg_roles r WHERE r.rolname=current_user
    ),
    expected_functions(name_arity) AS (SELECT unnest($1::text[])),
    expected_tables(name) AS (SELECT unnest($2::text[])),
    function_state AS (
      SELECT p.proname||'/'||p.pronargs AS name_arity,has_function_privilege(current_user,p.oid,'EXECUTE') AS can_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='freehold' AND p.prokind IN ('f','p')
    ),
    table_state AS (
      SELECT c.relname,
        has_table_privilege(current_user,c.oid,'SELECT') AS can_select,
        (has_table_privilege(current_user,c.oid,'INSERT') OR has_table_privilege(current_user,c.oid,'UPDATE') OR
         has_table_privilege(current_user,c.oid,'DELETE') OR has_table_privilege(current_user,c.oid,'TRUNCATE') OR
         has_table_privilege(current_user,c.oid,'REFERENCES') OR has_table_privilege(current_user,c.oid,'TRIGGER')) AS can_write
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='freehold' AND c.relkind IN ('r','p','v','m','f')
    ),
    sequence_state AS (
      SELECT bool_or(has_sequence_privilege(current_user,c.oid,'USAGE') OR
                     has_sequence_privilege(current_user,c.oid,'SELECT') OR
                     has_sequence_privilege(current_user,c.oid,'UPDATE')) AS can_use
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='freehold' AND c.relkind='S'
    )
    SELECT COALESCE((
      SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole AND
        NOT r.rolreplication AND NOT r.rolbypassrls AND NOT r.rolinherit AND NOT r.standby AND
        NOT pg_has_role(current_user,'freehold_app','MEMBER') AND
        NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) AND
        has_schema_privilege(current_user,'freehold','USAGE') AND
        NOT has_schema_privilege(current_user,'freehold','CREATE') AND
        NOT EXISTS(SELECT 1 FROM table_state WHERE can_write) AND
        NOT EXISTS(SELECT 1 FROM table_state t WHERE t.can_select AND NOT EXISTS
          (SELECT 1 FROM expected_tables e WHERE e.name=t.relname)) AND
        NOT EXISTS(SELECT 1 FROM expected_tables e WHERE NOT EXISTS
          (SELECT 1 FROM table_state t WHERE t.relname=e.name AND t.can_select)) AND
        NOT COALESCE((SELECT can_use FROM sequence_state),false) AND
        NOT EXISTS(SELECT 1 FROM function_state f WHERE f.can_execute AND NOT EXISTS
          (SELECT 1 FROM expected_functions e WHERE e.name_arity=f.name_arity)) AND
        NOT EXISTS(SELECT 1 FROM expected_functions e WHERE NOT EXISTS
          (SELECT 1 FROM function_state f WHERE f.name_arity=e.name_arity AND f.can_execute))
      FROM role_state r
    ),false) AS valid`, [functions, tables]);
  if (!rows[0]?.valid || expectedRole !== (await client.query<{ name: string }>('SELECT current_user AS name')).rows[0]?.name) {
    throw new Error(`The ${expectedRole} connection must be that exact least-privilege login on the primary`);
  }
}
