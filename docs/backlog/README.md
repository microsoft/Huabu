# Backlog

Backlog documents capture uncommitted ideas that may be revisited but are not approved architecture or active implementation plans.

Every backlog document must carry `Status: Backlog` and a `Last reviewed:` date near the top. It should state which assumptions remain unvalidated and link to any current architecture that constrains the idea.

Agents must not treat backlog content as a contract or implementation instruction. Before implementation begins, promote the idea into `docs/proposals/` through `git mv`, update its status, and resolve stale assumptions against `docs/architecture/`.
