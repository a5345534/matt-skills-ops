# Workflow metadata lives in a spec-issue manifest

Matt Auto stores orchestration metadata in a managed structured comment on the workflow’s spec issue. The manifest records branches, the Worker profile snapshot, attempts, PR and CI references, and stage state while GitHub issues and dependencies continue to represent user-facing work. This preserves recoverability without modifying Matt skill output in the spec body or proliferating state labels.
