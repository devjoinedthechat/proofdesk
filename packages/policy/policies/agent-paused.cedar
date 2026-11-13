// The kill switch. While the agent is paused it may do nothing, and no
// approval overrides that.
forbid (principal, action, resource)
when { context.agentPaused };
