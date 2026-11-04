-- ─── Ticket Queue System ────────────────────────────────────────
-- Enables N AI agents to work in parallel on the same repo,
-- each on their own branch, with serialized merges to main.

-- ─── Tickets ────────────────────────────────────────────────────
-- A ticket represents a unit of work assigned to an agent
CREATE TABLE IF NOT EXISTS tickets (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,          -- which AI agent owns this ticket
	title TEXT NOT NULL,
	description TEXT,
	branch TEXT NOT NULL,            -- agent's working branch (e.g. agent/ticket-xxx)
	base_branch TEXT NOT NULL DEFAULT 'main', -- target branch to merge into
	status TEXT NOT NULL DEFAULT 'queued',
	  -- queued:     waiting to be picked up
	  -- active:     agent is working on it
	  -- review:     agent finished, awaiting merge
	  -- merging:    in the merge queue, being rebased/merged
	  -- merged:     successfully merged to base_branch
	  -- failed:     merge failed (conflict), needs agent retry
	  -- cancelled:  manually cancelled
	priority INTEGER NOT NULL DEFAULT 0, -- higher = higher priority in queue
	queue_position INTEGER,              -- position in merge queue (NULL = not queued for merge)
	commit_sha TEXT,                     -- latest commit on the agent's branch
	merge_commit_sha TEXT,               -- commit SHA after merge to base_branch
	merge_attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now')),
	started_at TEXT,                     -- when agent started working
	completed_at TEXT,                   -- when merge completed
	FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tickets_repo ON tickets(repo_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_agent ON tickets(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets(repo_id, base_branch, queue_position);
CREATE INDEX IF NOT EXISTS idx_tickets_branch ON tickets(repo_id, branch);

-- ─── Merge Queue Log ────────────────────────────────────────────
-- Audit trail of all merge queue operations
CREATE TABLE IF NOT EXISTS merge_queue_log (
	id TEXT PRIMARY KEY,
	repo_id TEXT NOT NULL,
	ticket_id TEXT NOT NULL,
	action TEXT NOT NULL, 
	  -- enqueued:      ticket entered the merge queue
	  -- dequeued:      ticket removed (cancelled or failed)
	  -- merge_start:   merge attempt started
	  -- merge_success: merge completed
	  -- merge_fail:    merge had conflicts
	  -- rebase_start:  rebase attempt started
	  -- rebase_success:rebase completed
	  -- rebase_fail:   rebase had conflicts
	  -- retry:         ticket re-enqueued after failure
	details TEXT,        -- JSON with action-specific info
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (repo_id) REFERENCES repositories(id) ON DELETE CASCADE,
	FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_merge_log_repo ON merge_queue_log(repo_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_merge_log_ticket ON merge_queue_log(ticket_id, created_at DESC);
