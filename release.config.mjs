export default {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        preset: "conventionalcommits",
        presetConfig: {},
        releaseRules: [
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
    "@semantic-release/npm",
    [
      "@semantic-release/github",
      { successCommentCondition: false, failCommentCondition: false },
    ],
  ],
};
