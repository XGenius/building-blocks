-- Scrape Jobs Queue Schema
-- Run this in your Supabase SQL editor or as a migration

-- Create the scrape_jobs table
create table if not exists scrape_jobs (
  id uuid primary key default gen_random_uuid(),
  
  -- Input
  url text not null,
  max_pages int not null default 20,
  max_concurrency int not null default 5,
  include_sitemap boolean not null default true,
  
  -- Status: queued → started → completed/failed
  status text not null default 'queued',
  
  -- Result (populated on completion)
  result jsonb,
  
  -- Error tracking
  error text,
  retry_count int not null default 0,
  max_retries int not null default 3,
  
  -- Timestamps
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Index for efficient queue polling (only queued items)
create index if not exists idx_scrape_jobs_queued 
  on scrape_jobs(created_at) 
  where status = 'queued';

-- Index for finding stuck jobs
create index if not exists idx_scrape_jobs_started 
  on scrape_jobs(claimed_at) 
  where status = 'started';

-- Index for looking up by URL (optional, for deduplication)
create index if not exists idx_scrape_jobs_url 
  on scrape_jobs(url, status);

-- Function to update updated_at on changes
create or replace function update_updated_at_column()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger to auto-update updated_at
drop trigger if exists update_scrape_jobs_updated_at on scrape_jobs;
create trigger update_scrape_jobs_updated_at
  before update on scrape_jobs
  for each row
  execute function update_updated_at_column();

-- Enable RLS (optional - enable if you want row-level security)
-- alter table scrape_jobs enable row level security;

-- Example RLS policy for service role access only
-- create policy "Service role full access" on scrape_jobs
--   for all using (auth.role() = 'service_role');

comment on table scrape_jobs is 'Queue for async web scraping jobs';
comment on column scrape_jobs.status is 'Job status: queued, started, completed, failed';
comment on column scrape_jobs.retry_count is 'Number of retry attempts after retriable failures';
comment on column scrape_jobs.result is 'Scrape result JSON (pages array, metadata)';
