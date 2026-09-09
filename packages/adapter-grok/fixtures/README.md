# Grok hook fixtures

Shape from Grok **1.0.13** published hook docs (`hookEventName`, `sessionId`,
`toolName`, `toolInput`). Event names `user_prompt_submit`, `pre_tool_use`,
`post_tool_use`, `stop`, and `session_end` were observed firing in a real TUI
session; the TUI log records name/status/elapsed_ms, not the stdin body.

Conversation content is redacted. Paths are invented so a guard has something
to compare against a claim.

[CLI ownership observations on Grok 1.0.24](cli-owner-grok-1.0.24.json) record two
real independently launched clients using a locally installed development artifact.
This is a normalized summary of observed tool context, owned operations, and public
ACC state, not a native payload fixture or capability certification. It is not packed.
