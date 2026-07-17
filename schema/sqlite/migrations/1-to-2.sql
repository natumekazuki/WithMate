UPDATE sessions
SET max_concurrent_child_runs = 1024
WHERE max_concurrent_child_runs > 1024;

CREATE TRIGGER sessions_max_concurrent_child_runs_insert
BEFORE INSERT ON sessions
WHEN NEW.max_concurrent_child_runs < 0 OR NEW.max_concurrent_child_runs > 1024
BEGIN
  SELECT RAISE(ABORT, 'max_concurrent_child_runs_out_of_range');
END;

CREATE TRIGGER sessions_max_concurrent_child_runs_update
BEFORE UPDATE OF max_concurrent_child_runs ON sessions
WHEN NEW.max_concurrent_child_runs < 0 OR NEW.max_concurrent_child_runs > 1024
BEGIN
  SELECT RAISE(ABORT, 'max_concurrent_child_runs_out_of_range');
END;
