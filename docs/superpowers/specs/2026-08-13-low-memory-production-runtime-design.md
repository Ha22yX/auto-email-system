# Low-Memory Production Runtime Design

## Goal

Reduce the production service's steady-state memory usage on a 2 GB server without weakening automatic recovery or changing mail-processing behavior.

## Design

The Baota process entrypoint will run a Bash supervisor directly. The supervisor launches exactly one Node application process, performs lightweight HTTP health checks with `curl`, restarts failed or unhealthy children with bounded exponential backoff, and forwards termination signals cleanly.

The application heap limit defaults to 384 MB instead of 640 MB. `MALLOC_ARENA_MAX=2` limits allocator fragmentation during long-running mail and attachment processing. Both values remain overridable through environment variables.

## Safety

- Existing IMAP listeners, polling, processing queues, SQLite state, and notification behavior remain unchanged.
- A child that exits or fails three consecutive health checks is restarted automatically.
- Rapid crash loops back off up to 30 seconds; a process that remains healthy for 60 seconds resets the backoff.
- Baota continues to own the supervisor PID and can start, stop, and restart the project normally.

## Verification

- A regression test verifies the production start command, 384 MB heap default, allocator setting, health check, signal forwarding, and restart loop.
- The full test suite and production build must pass.
- On the server, `bash -n`, the health endpoint, public HTTPS, Baota PID ownership, restart recovery, and before/after RSS are checked.
