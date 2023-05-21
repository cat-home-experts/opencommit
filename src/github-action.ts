import core from '@actions/core';
import github from '@actions/github';
import exec from '@actions/exec';
import { intro, outro } from '@clack/prompts';
import { PullRequestEvent } from '@octokit/webhooks-types';
import { generateCommitMessageByDiff } from './generateCommitMessageFromGitDiff';
import { sleep } from './utils/sleep';
import { randomIntFromInterval } from './utils/randomIntFromInterval';
import { unlinkSync, writeFileSync } from 'fs';
import { promisify } from 'util';
import { exec as cpExec } from 'child_process';
const execPromise = promisify(cpExec);

// This should be a token with access to your repository scoped in as a secret.
// The YML workflow will need to set GITHUB_TOKEN with the GitHub Secret Token
// GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
// https://help.github.com/en/actions/automating-your-workflow-with-github-actions/authenticating-with-the-github_token#about-the-github_token-secret
const GITHUB_TOKEN = core.getInput('GITHUB_TOKEN');
const pattern = core.getInput('pattern');
const octokit = github.getOctokit(GITHUB_TOKEN);
const context = github.context;
const owner = context.repo.owner;
const repo = context.repo.repo;

type ListCommitsResponse = ReturnType<typeof octokit.rest.pulls.listCommits>;

type CommitsData = ListCommitsResponse extends Promise<infer T> ? T : never;

type CommitsArray = CommitsData['data'];

type SHA = string;
type Diff = string;

async function getCommitDiff(commitSha: string) {
  const diffResponse = await octokit.request<string>(
    'GET /repos/{owner}/{repo}/commits/{ref}',
    {
      owner,
      repo,
      ref: commitSha,
      headers: {
        Accept: 'application/vnd.github.v3.diff'
      }
    }
  );
  return { sha: commitSha, diff: diffResponse.data };
}

interface DiffAndSHA {
  sha: SHA;
  diff: Diff;
}

interface MsgAndSHA {
  sha: SHA;
  msg: string;
}

type MessageBySHA = Record<SHA, string>;

// send 3-4 size chunks of diffs in parallel,
// because openAI restricts too many requests at once with 429 error
async function improveMessagesInChunks(diffsAndSHAs: DiffAndSHA[]) {
  const chunkSize = diffsAndSHAs!.length % 2 === 0 ? 4 : 3;
  outro(`Improving commit messages in chunks of ${chunkSize}.`);
  const improvePromises = diffsAndSHAs!.map((commit) =>
    generateCommitMessageByDiff(commit.diff)
  );

  let improvedMessagesAndSHAs: MsgAndSHA[] = [];
  for (let step = 0; step < improvePromises.length; step += chunkSize) {
    const chunkOfPromises = improvePromises.slice(step, step + chunkSize);

    try {
      // TODO: refactor to Promise.allSettled, to only retry rejected promises
      const chunkOfImprovedMessages = await Promise.all(chunkOfPromises);

      const chunkOfImprovedMessagesBySha = chunkOfImprovedMessages.map(
        (improvedMsg, i) => {
          const index = improvedMessagesAndSHAs.length;
          const sha = diffsAndSHAs![index + i].sha;

          return { sha, msg: improvedMsg };
        }
      );

      improvedMessagesAndSHAs.push(...chunkOfImprovedMessagesBySha);

      // openAI errors with 429 code (too many requests) so lets sleep a bit
      const sleepFor =
        1000 * randomIntFromInterval(1, 5) +
        100 * (step / chunkSize) +
        100 * randomIntFromInterval(1, 5);

      outro(
        `Improved ${chunkOfPromises.length} messages. Sleeping for ${sleepFor}`
      );

      await sleep(sleepFor);
    } catch (error) {
      outro(error as string);

      // if sleeping in try block doesn't work,
      // openAI wants at least 20 seconds before next request
      const sleepFor = 20000 + 1000 * randomIntFromInterval(1, 5);
      outro(`Retrying after sleeping for ${sleepFor}`);
      await sleep(sleepFor);

      // go to previous step
      step -= chunkSize;
    }
  }

  return improvedMessagesAndSHAs;
}

const getDiffsBySHAs = async (SHAs: string[]) => {
  const diffPromises = SHAs.map((sha) => getCommitDiff(sha));

  const diffs = await Promise.all(diffPromises).catch((error) => {
    outro(`error in Promise.all(getCommitDiffs(SHAs)): ${error}`);
    throw error;
  });

  return diffs;
};

async function improveCommitMessages(commits: CommitsArray): Promise<void> {
  let commitsToImprove = pattern
    ? commits.filter(({ commit }) => new RegExp(pattern).test(commit.message))
    : commits;

  if (commitsToImprove.length) {
    outro(`Found ${commitsToImprove.length} commits to improve.`);
  } else {
    outro('No new commits found.');
    return;
  }

  outro('Fetching commit diffs by SHAs.');
  const commitSHAsToImprove = commitsToImprove.map((commit) => commit.sha);
  const diffsWithSHAs = await getDiffsBySHAs(commitSHAsToImprove);
  outro('Done.');

  const improvedMessagesWithSHAs = await improveMessagesInChunks(diffsWithSHAs);

  console.log(
    `Improved ${improvedMessagesWithSHAs.length} commits: `,
    improvedMessagesWithSHAs
  );

  const createCommitMessageFile = (message: string, index: number) =>
    writeFileSync(`./commit-${index}.txt`, message);
  improvedMessagesWithSHAs.forEach(({ msg }, i) =>
    createCommitMessageFile(msg, i)
  );

  writeFileSync(`./count.txt`, '0');

  writeFileSync(
    './rebase-exec.sh',
    '#!/bin/bash count=$(cat count.txt) git commit --amend -F commit-$count.txt echo $(( count + 1 )) > count.txt'
  );

  await exec.exec(`chmod +x ./rebase-exec.sh`);

  await exec.exec(
    'git',
    ['rebase', `${commitsToImprove[0].sha}^`, '--exec', './rebase-exec.sh'],
    {
      env: {
        GIT_SEQUENCE_EDITOR: 'sed -i -e "s/^pick/reword/g"',
        GIT_COMMITTER_NAME: process.env.GITHUB_ACTOR!,
        GIT_COMMITTER_EMAIL: `${process.env.GITHUB_ACTOR}@users.noreply.github.com`
      }
    }
  );

  const deleteCommitMessageFile = (index: number) =>
    unlinkSync(`./commit-${index}.txt`);
  commitsToImprove.forEach((_commit, i) => deleteCommitMessageFile(i));

  unlinkSync('./count.txt');
  unlinkSync('./rebase-exec.sh');

  outro('Force pushing non-interactively rebased commits into remote origin.');

  await exec.exec('git', ['status']);

  // Force push the rebased commits
  await exec.exec('git', ['push', 'origin', `--force`]);

  outro('Done 🧙');
}

async function run(retries = 3) {
  intro('OpenCommit — improving commit messages with GPT');

  // Set the Git identity
  await exec.exec('git', [
    'config',
    'user.email',
    `${process.env.GITHUB_ACTOR}@users.noreply.github.com`
  ]);

  await exec.exec('git', ['config', 'user.name', process.env.GITHUB_ACTOR!]);

  try {
    if (github.context.eventName === 'pull_request') {
      const baseBranch = github.context.payload.pull_request?.base.ref;
      const sourceBranch = github.context.payload.pull_request?.head.ref;
      outro(
        `Processing commits in a Pull Request from source: (${sourceBranch}) to base: (${baseBranch})`
      );
      if (github.context.payload.action === 'opened')
        outro('Pull Request action: opened');
      else if (github.context.payload.action === 'synchronize')
        outro('Pull Request action: synchronize');
      else
        return outro(
          'Pull Request unhandled action: ' + github.context.payload.action
        );

      const payload = github.context.payload as PullRequestEvent;

      const commitsResponse = await octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: payload.pull_request.number
      });

      const commits = commitsResponse.data;

      await exec.exec('git', ['status']);
      await exec.exec('git', ['log', '--oneline']);

      await improveCommitMessages(commits);
    } else {
      outro('Wrong action.');
      core.error(
        `OpenCommit was called on ${github.context.payload.action}. OpenCommit is not supposed to be used on actions other from "pull_request.opened" and "pull_request.synchronize".`
      );
    }
  } catch (error: any) {
    const err = error?.message || error;
    outro(err);
    // if (retries) run(--retries);
    // else core.setFailed(error?.message || error);
    core.setFailed(err);
  }
}

run();
