# Grok hook fixtures

Shape from Grok **1.0.13** published hook docs (`hookEventName`, `sessionId`,
`toolName`, `toolInput`). Event names `user_prompt_submit`, `pre_tool_use`,
`post_tool_use`, `stop`, and `session_end` were observed firing in a real TUI
session; the TUI log records name/status/elapsed_ms, not the stdin body.

Conversation content is redacted. Paths are invented so a guard has something
to compare against a claim.
