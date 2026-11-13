// The kill switch for one tool. While a tool is paused the agent may not call
// it, and no approval overrides that. Everything else keeps working.
forbid (principal, action, resource)
when { context.toolPaused };
