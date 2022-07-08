const { context, getOctokit } = require("@actions/github");
const { info, getInput, setOutput, setFailed } = require("@actions/core");
const compareVersions = require("compare-versions");

const parseCommitMessage = require("./parseCommitMessage");
const generateChangelog = require("./generateChangelog");
const DEFAULT_CONFIG = require("./defaultConfig");

const {
  repo: { owner, repo },
} = context;

function getConfig(path) {
  if (path) {
    let workspace = process.env.GITHUB_WORKSPACE;
    if (process.env.ACT) {
      // Otherwise testing this in ACT doesn't work
      workspace += "/tag-changelog";
    }

    const userConfig = require(`${workspace}/${path}`);

    // Merge default config with user config
    return Object.assign({}, DEFAULT_CONFIG, userConfig);
  }

  return DEFAULT_CONFIG;
}

async function run() {
  const token = getInput("token", { required: true });
  const octokit = getOctokit(token);

  const configFile = getInput("config_file", { required: false });
  const config = getConfig(configFile);
  const excludeTypesString = getInput("exclude_types", { required: false }) || "";
  const ref = getInput("ref") || "tags";

  if (excludeTypesString) {
    config.excludeTypes = excludeTypesString.split(",");
  }

  // Find the two most recent tags
  const { data: refs } = await octokit.request("GET /repos/{owner}/{repo}/git/matching-refs/{ref}", {
    owner: owner,
    repo: repo,
    ref: ref,
  });

  const validSortedTags = refs
    .filter((t) => compareVersions.validate(t.ref.replace("refs/tags/", "")))
    .sort((a, b) => {
      return compareVersions(a.ref.replace("refs/tags/", ""), b.ref.replace("refs/tags/", ""));
    })
    .reverse();

  if (validSortedTags.length < 2) {
    setFailed("Couldn't find previous tag");
    return;
  }

  // Find the commits between two tags
  const result = await octokit.repos.compareCommits({
    owner,
    repo,
    base: validSortedTags[1].object.sha,
    head: validSortedTags[0].object.sha,
  });

  const fetchUserFunc = async function (pullNumber) {
    const pr = await octokit.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });

    return {
      username: pr.data.user.login,
      userUrl: pr.data.user.html_url,
    };
  };

  // Parse every commit, getting the type, turning PR numbers into links, etc
  const commitObjects = await Promise.all(
    result.data.commits
      .map(async (commit) => {
        const commitObj = await parseCommitMessage(commit.commit.message, `https://github.com/${owner}/${repo}`, fetchUserFunc);
        commitObj.sha = commit.sha;
        commitObj.url = commit.html_url;
        commitObj.author = commit.author;
        return commitObj;
      })
      .filter((m) => m !== false)
  );

  // And generate the changelog
  if (commitObjects.length === 0) {
    setOutput("changelog", "");
    setOutput("changes", "");
    return;
  }

  const log = generateChangelog(validSortedTags[0].ref.replace("refs/tags/", ""), commitObjects, config);

  info(log.changelog);
  setOutput("changelog", log.changelog);
  setOutput("changes", log.changes);
}

run();
