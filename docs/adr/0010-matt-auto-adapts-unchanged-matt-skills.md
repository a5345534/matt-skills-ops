# Matt Auto adapts unchanged Matt skills

Matt Auto discovers and invokes installed Matt skills as runtime capabilities without modifying, bundling, overriding, or pinning their `SKILL.md` definitions. It uses an orchestration wrapper, Stage results, and observable GitHub artifacts to coordinate them. If a future skill update omits an expected result or artifact, Matt Auto enters Compatibility recovery instead of guessing or mutating workflow state.
