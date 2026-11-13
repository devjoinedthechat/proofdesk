import { defineConfig } from "vitest/config";

const packages = "{apps,services,mcp,packages}/*/src";

export default defineConfig({
  test: {
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
