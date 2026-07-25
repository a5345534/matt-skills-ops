# Stage results drive workflow transitions

Matt Auto transitions only when an orchestrated agent emits one structured Stage result for completion, failure, or a confirmation boundary. We choose event-driven reports over background polling and prose inference because transitions stay explicit, cancellable, and recoverable; if no result arrives after the agent settles, Matt Auto offers recovery rather than waiting.
