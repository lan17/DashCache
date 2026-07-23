export default {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        presetConfig: {},
        releaseRules: [
          // A version PR records the selected version without selecting a new
          // release itself. Earlier commits still determine the release type.
          { type: "release", release: false },
          { breaking: true, release: "major" },
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "perf", release: "patch" },
          { type: "docs", release: "patch" },
          { type: "style", release: "patch" },
          { type: "refactor", release: "patch" },
          { type: "test", release: "patch" },
          { type: "build", release: "patch" },
          { type: "chore", release: "patch" },
          { type: "ci", release: "patch" },
          { type: "revert", release: "patch" },
        ],
      },
    ],
    [
      "@semantic-release/release-notes-generator",
      { preset: "conventionalcommits", presetConfig: {} },
    ],
    ...(process.env.DIALCACHE_RELEASE_PLAN_ONLY === "true"
      ? []
      : [
          "@semantic-release/npm",
          [
            "@semantic-release/github",
            { successCommentCondition: false, failCommentCondition: false },
          ],
        ]),
  ],
};
