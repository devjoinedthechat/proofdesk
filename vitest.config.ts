import { defineConfig } from "vitest/config";

const packages = "{apps,services,mcp,packages}/*/src";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      include: [`${packages}/**/*.ts`],
      exclude: [
        "**/*.{test,itest}.ts",
        // Code that only ever runs in a process of its own, where this run
        // cannot see it. The separate-process test and the smoke test are
        // what exercise it.
        "**/main.ts",
        "apps/stack/src/**",
        "apps/worker/src/testing/**",
        // Workflow code runs inside the engine's sandbox.
        "apps/worker/src/workflows.ts",
        // Commands a person runs: evals on a real model, the load
        // measurement, and the removal of controls.
        "**/cli.ts",
        "**/*-cli.ts",
        "packages/evals/src/{eval-run,retrieval-eval,query-eval,screen-eval,replay-fixture}.ts",
        "apps/worker/src/load.ts",
        // Runs as a child process of the test that uses it.
        "packages/evals/src/testing/**",
        "packages/evals/src/redteam.ts",
        "packages/claims/src/{prove,write}.ts",
      ],
      // A floor, a little under what the suite reaches today. It is there
      // to catch a part of the system losing its tests, not to be a target.
      thresholds: { lines: 93, statements: 91, functions: 90, branches: 80 },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: [`${packages}/**/*.test.ts`],
        },
      },
      {
        // Tests that need Postgres. One container serves the whole run, and
        // each test works on its own copy of a template database.
        test: {
          name: "integration",
          include: [`${packages}/**/*.itest.ts`],
          globalSetup: ["./test/global-setup.ts"],
          // Generous on purpose. Thirty files share one Postgres, one
          // Keycloak and one Temporal, and on a busy machine a database copy
          // that takes a second can take a minute. A test that is stuck
          // still fails; a test that is slow no longer does.
          testTimeout: 120_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
