# bugcast (MCP server)

Query [bugcast](https://github.com/SimplerDevelopment/bugcast) QA session
folders from a coding agent.

**Optional.** Recording does not need this, and neither does reading a session —
you can always just point your agent at `report.md`. This exists because a
fifteen-minute session's raw `timeline.json` runs to roughly 50k tokens, and
pasting all of it to ask "what failed" is exactly the waste the tool is meant to
remove.

## Setup

```jsonc
{
  "mcpServers": {
    "bugcast": {
      "command": "npx",
      "args": ["-y", "bugcast", "--dir", "/path/to/your/sessions"]
    }
  }
}
```

Use the same folder you chose in the extension. It cannot be discovered
automatically — the File System Access API never exposes an absolute path, so
the extension does not know it either.

## Tools

| Tool | |
|---|---|
| `sessions_list` | Recent sessions, newest first |
| `session_report` | The human-readable rendering. Start here. |
| `session_query` | A filtered slice of the timeline. `failedOnly: true` answers "what went wrong". |
| `session_frame` | The JPEG nearest a moment, for looking at what the page showed |

## Read-only, always

No write, no delete, no move. An agent must not be able to destroy the evidence
it was asked to look at.

Session ids are resolved against the actual directory listing rather than joined
onto a path — an id arrives from a model, which makes it attacker-influenced the
moment anyone shares a session folder, and `..` is the obvious way out.

The server refuses a `schemaVersion` it does not know rather than parsing it
best-effort, because subtly wrong answers to an agent that will act on them are
worse than none.

MIT.
