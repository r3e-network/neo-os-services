alter table morpheus_automation_jobs
  drop constraint if exists morpheus_automation_jobs_status_check;

alter table morpheus_automation_jobs
  add constraint morpheus_automation_jobs_status_check
  check (status in ('active', 'paused', 'cancelled', 'completed', 'error', 'processing'));
