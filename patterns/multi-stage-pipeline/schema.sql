-- Multi-Stage Pipeline Schema
-- 
-- This schema demonstrates how to structure an entity (e.g., lead) with multiple
-- independent processing stages, each with its own status field.
--
-- Key principles:
-- 1. Status columns on the entity itself (not separate jobs table)
-- 2. Job IDs stored for completion polling
-- 3. Timestamps for stuck job detection
-- 4. Indexes for efficient queue polling

-- =============================================================================
-- STATUS TYPE
-- =============================================================================

-- Using text with check constraint for flexibility
-- (enums require migrations to add new values)
create or replace function check_stage_status(status text) returns boolean as $$
begin
  return status in ('pending', 'queued', 'started', 'completed', 'failed');
end;
$$ language plpgsql immutable;

-- =============================================================================
-- LEADS TABLE (Example Entity)
-- =============================================================================

create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  
  -- Core lead data
  email text not null,
  company_name text,
  company_url text,
  contact_name text,
  
  -- ==========================================================================
  -- STAGE 1: Web Scraping
  -- ==========================================================================
  scrape_status text not null default 'pending' 
    check (check_stage_status(scrape_status)),
  scrape_job_id text,                    -- Job ID from scraper service
  scrape_result jsonb,                   -- Scraped content (pages, metadata)
  scrape_error text,                     -- Error message if failed
  scrape_retry_count int not null default 0,
  scrape_started_at timestamptz,
  scrape_completed_at timestamptz,
  
  -- ==========================================================================
  -- STAGE 2: Sales Intelligence
  -- ==========================================================================
  intel_status text not null default 'pending'
    check (check_stage_status(intel_status)),
  intel_job_id text,                     -- Job ID from LLM service
  intel_result jsonb,                    -- Intelligence report
  intel_error text,
  intel_retry_count int not null default 0,
  intel_started_at timestamptz,
  intel_completed_at timestamptz,
  
  -- ==========================================================================
  -- STAGE 3: Strategy Generation
  -- ==========================================================================
  strategy_status text not null default 'pending'
    check (check_stage_status(strategy_status)),
  strategy_job_id text,
  strategy_result jsonb,                 -- Messaging strategy
  strategy_error text,
  strategy_retry_count int not null default 0,
  strategy_started_at timestamptz,
  strategy_completed_at timestamptz,
  
  -- ==========================================================================
  -- STAGE 4: Subject Line Generation
  -- ==========================================================================
  subject_status text not null default 'pending'
    check (check_stage_status(subject_status)),
  subject_job_id text,
  subject_result jsonb,                  -- Generated subject lines
  subject_error text,
  subject_retry_count int not null default 0,
  subject_started_at timestamptz,
  subject_completed_at timestamptz,
  
  -- ==========================================================================
  -- STAGE 5: Email Messaging
  -- ==========================================================================
  messaging_status text not null default 'pending'
    check (check_stage_status(messaging_status)),
  messaging_job_id text,
  messaging_result jsonb,                -- Generated email content
  messaging_error text,
  messaging_retry_count int not null default 0,
  messaging_started_at timestamptz,
  messaging_completed_at timestamptz,
  
  -- ==========================================================================
  -- Metadata
  -- ==========================================================================
  account_id uuid not null,              -- Owner account
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- =============================================================================
-- INDEXES FOR QUEUE POLLING
-- =============================================================================

-- Each stage needs an index for finding queued items efficiently
-- Partial indexes only include rows where status = 'queued' (tiny index)

create index if not exists idx_leads_scrape_queued 
  on leads(created_at) 
  where scrape_status = 'queued';

create index if not exists idx_leads_intel_queued 
  on leads(created_at) 
  where intel_status = 'queued';

create index if not exists idx_leads_strategy_queued 
  on leads(created_at) 
  where strategy_status = 'queued';

create index if not exists idx_leads_subject_queued 
  on leads(created_at) 
  where subject_status = 'queued';

create index if not exists idx_leads_messaging_queued 
  on leads(created_at) 
  where messaging_status = 'queued';

-- =============================================================================
-- INDEXES FOR COMPLETION POLLING
-- =============================================================================

-- Find items that are 'started' (waiting for job completion)

create index if not exists idx_leads_scrape_started 
  on leads(scrape_started_at) 
  where scrape_status = 'started';

create index if not exists idx_leads_intel_started 
  on leads(intel_started_at) 
  where intel_status = 'started';

create index if not exists idx_leads_strategy_started 
  on leads(strategy_started_at) 
  where strategy_status = 'started';

create index if not exists idx_leads_subject_started 
  on leads(subject_started_at) 
  where subject_status = 'started';

create index if not exists idx_leads_messaging_started 
  on leads(messaging_started_at) 
  where messaging_status = 'started';

-- =============================================================================
-- INDEXES FOR JOB ID LOOKUP (Webhook callbacks)
-- =============================================================================

create index if not exists idx_leads_scrape_job_id 
  on leads(scrape_job_id) 
  where scrape_job_id is not null;

create index if not exists idx_leads_intel_job_id 
  on leads(intel_job_id) 
  where intel_job_id is not null;

create index if not exists idx_leads_strategy_job_id 
  on leads(strategy_job_id) 
  where strategy_job_id is not null;

create index if not exists idx_leads_subject_job_id 
  on leads(subject_job_id) 
  where subject_job_id is not null;

create index if not exists idx_leads_messaging_job_id 
  on leads(messaging_job_id) 
  where messaging_job_id is not null;

-- =============================================================================
-- UPDATED_AT TRIGGER
-- =============================================================================

create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists update_leads_updated_at on leads;
create trigger update_leads_updated_at
  before update on leads
  for each row
  execute function update_updated_at_column();

-- =============================================================================
-- HELPER VIEWS
-- =============================================================================

-- View showing pipeline progress for each lead
create or replace view lead_pipeline_status as
select 
  id,
  email,
  company_name,
  scrape_status,
  intel_status,
  strategy_status,
  subject_status,
  messaging_status,
  -- Calculate overall progress
  case 
    when messaging_status = 'completed' then 'complete'
    when messaging_status = 'failed' or subject_status = 'failed' 
      or strategy_status = 'failed' or intel_status = 'failed' 
      or scrape_status = 'failed' then 'failed'
    when messaging_status in ('queued', 'started') then 'messaging'
    when subject_status in ('queued', 'started') then 'subject'
    when strategy_status in ('queued', 'started') then 'strategy'
    when intel_status in ('queued', 'started') then 'intel'
    when scrape_status in ('queued', 'started') then 'scrape'
    else 'pending'
  end as current_stage,
  created_at,
  updated_at
from leads;

-- =============================================================================
-- COMMENTS
-- =============================================================================

comment on table leads is 'Leads with multi-stage processing pipeline';
comment on column leads.scrape_status is 'Web scraping stage: pending → queued → started → completed/failed';
comment on column leads.scrape_job_id is 'Job ID from scraper service for completion polling';
comment on column leads.intel_status is 'Sales intelligence stage: pending → queued → started → completed/failed';
